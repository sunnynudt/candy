import path from "node:path";
import { stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  NativeProcessRunner,
  resolveAppPaths,
  resolveCredential,
  resolveDefaultAppDataRoot,
  resolveNativeProcessRunnerPath,
  SQLiteTaskStore,
  SystemClock,
  type CandyModelId,
  DEFAULT_CANDY_MODEL,
  type TaskMetadata,
} from "@candy/platform";
import { PiAgentEngine, type PiAgentEngineInput, type PiAgentObservation } from "@candy/pi-adapter";
import {
  CommandLedger,
  decodeJsonLines,
  encodeJsonLine,
  validateProtocolMessage,
  type CommandEnvelope,
  type EventEnvelope,
  type ProtocolMessage,
  type RuntimeEvent,
  type TaskProgress,
  type TaskSnapshot,
} from "@candy/protocol";
import {
  ApplyChangesBlockedError,
  ApplyChangesService,
  CommandValidator,
  DeterministicAgentEngine,
  AttachmentStore,
  GitWorktreeManager,
  GitWorkspaceChangeTracker,
  LongRunningControlError,
  LongRunningTaskRunner,
  MAX_TASK_ATTACHMENT_BYTES,
  MAX_TASK_ATTACHMENT_COUNT,
  NonGitWorkspaceChangeTracker,
  ResolvedWorkspaceChangeTracker,
  WorkspaceHandoff,
  type AgentObservation,
  type AgentTurnInput,
  type ApplyChangesInput,
  type GitWorktreePlan,
  type RecoverableAgentEngine,
  type CommandValidatorCommand,
  type ValidatorResult,
  type WorkspaceChangeTracker,
  planGitWorktree,
  resolveGitCommonDirectory,
} from "@candy/runtime";

interface PiTurnEngine {
  runTurn(input: PiAgentEngineInput, signal: AbortSignal): AsyncIterable<PiAgentObservation>;
  recoverPrompt(taskId: string, cwd: string): Promise<string | undefined>;
}

export class PiAppServerEngine implements RecoverableAgentEngine {
  public constructor(
    private readonly deepseek: PiTurnEngine,
    private readonly minimax: PiTurnEngine,
  ) {}

  public async *runTurn(
    input: AgentTurnInput,
    signal: AbortSignal,
  ): AsyncIterable<AgentObservation> {
    const model: CandyModelId = input.model ?? DEFAULT_CANDY_MODEL;
    const piInput: PiAgentEngineInput = {
      taskId: input.taskId,
      prompt: input.prompt,
      model,
      cwd: input.cwd ?? process.cwd(),
      ...(input.approvalProfile === undefined ? {} : { approvalProfile: input.approvalProfile }),
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
      ...(input.images === undefined ? {} : { images: input.images }),
      ...(input.activeSecrets === undefined ? {} : { activeSecrets: input.activeSecrets }),
      ...(input.trustedShell === undefined ? {} : { trustedShell: input.trustedShell }),
      ...(input.trustedGitCommonDirectory === undefined
        ? {}
        : { trustedGitCommonDirectory: input.trustedGitCommonDirectory }),
      ...(input.shellApproval === undefined ? {} : { shellApproval: input.shellApproval }),
    };
    const engine = model === "MiniMax-M3" ? this.minimax : this.deepseek;
    for await (const observation of engine.runTurn(piInput, signal)) {
      const mapped = mapPiObservation(observation);
      if (mapped !== undefined) yield mapped;
    }
  }

  public recoverPrompt(taskId: string, cwd: string): Promise<string | undefined> {
    return this.deepseek.recoverPrompt(taskId, cwd);
  }
}

export interface AppServerState {
  readonly protocolVersion: 1;
  readonly runtimeVersion: "0.0.0";
  readonly executingTasks: readonly string[];
}

/** Legacy single-message projection retained for the protocol smoke fixture. */
export function handleAppServerMessage(
  message: ProtocolMessage,
  state: AppServerState,
): ProtocolMessage {
  void state;
  if (message.kind === "command") {
    const command = message as CommandEnvelope;
    return {
      v: 1,
      kind: "event",
      taskId: command.taskId,
      sequence: 1,
      revision: command.expectedRevision,
      event: {
        type: "snapshot",
        snapshot: { taskId: command.taskId, revision: command.expectedRevision, state: "idle" },
      },
    };
  }
  return message;
}

export interface AppServerControllerOptions {
  readonly databasePath?: string;
  readonly engine?: RecoverableAgentEngine;
  readonly ownerId?: string;
  readonly attachments?: AttachmentStore;
  readonly validatorRunner?: AppServerValidator;
  readonly changeTracker?: WorkspaceChangeTracker;
  readonly activeSecrets?: () => readonly string[];
  readonly applyChanges?: ApplyChangesRunner;
  readonly worktreeRoot?: string;
  readonly worktreeManager?: TaskWorktreeManager;
  readonly platform?: NodeJS.Platform;
  readonly bashRunner?: {
    run(request: {
      readonly executable: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly workspace: string;
      readonly activeSecrets?: readonly string[];
      readonly signal?: AbortSignal;
    }): Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly cancelled: boolean;
    }>;
  };
}

interface AppServerValidator {
  run(
    command: CommandValidatorCommand,
    workspace: string,
    signal: AbortSignal,
  ): Promise<AppServerValidatorResult>;
}

interface AppServerValidatorResult {
  readonly ok: boolean;
  readonly fingerprint?: string;
  readonly evidence?: string;
  readonly durationMs?: number;
}

interface ApplyChangesRunner {
  apply(sourceRoot: string, input: ApplyChangesInput): Promise<"applied">;
}

interface TaskWorktreeManager {
  create(plan: GitWorktreePlan): Promise<void>;
  inspect(plan: GitWorktreePlan): Promise<string>;
  discard(plan: GitWorktreePlan): Promise<void>;
}

type Emit = (message: ProtocolMessage) => void;

interface ActiveTask {
  readonly abort: AbortController;
  done: Promise<void>;
  requestedStop?: "paused" | "cancelled";
}

interface PendingRun {
  readonly taskId: string;
  readonly emit: Emit;
}

interface PendingShellApproval {
  readonly request: { readonly command: string; readonly cwd: string; readonly timeout?: number };
  readonly approvalId: string;
  readonly resolve: (approved: boolean) => void;
}

/**
 * Durable task command loop used by Desktop and the app-server smoke path.
 * Prompts remain in the Pi-owned session path in the real engine; this
 * deterministic controller keeps the fixture prompt in memory only.
 */
export class AppServerController {
  readonly #store: SQLiteTaskStore;
  readonly #engine: RecoverableAgentEngine;
  readonly #ownerId: string;
  readonly #platform: NodeJS.Platform;
  readonly #attachments: AttachmentStore | undefined;
  readonly #validatorRunner: AppServerValidator | undefined;
  readonly #changeTracker: WorkspaceChangeTracker;
  readonly #activeSecrets: (() => readonly string[]) | undefined;
  readonly #applyChanges: ApplyChangesRunner | undefined;
  readonly #worktreeRoot: string | undefined;
  #worktreeManager: TaskWorktreeManager | undefined;
  readonly #handoffs = new Map<string, WorkspaceHandoff>();
  readonly #commands = new CommandLedger();
  readonly #prompts = new Map<string, string>();
  readonly #steering = new Map<string, string[]>();
  readonly #active = new Map<string, ActiveTask>();
  readonly #pendingRuns: PendingRun[] = [];
  readonly #requestedRuns = new Set<string>();
  readonly #bashRunner: AppServerControllerOptions["bashRunner"];
  readonly #shellApprovals = new Map<string, PendingShellApproval>();
  readonly #sequences = new Map<string, number>();
  #closed = false;
  #storeClosed = false;

  public constructor(options: AppServerControllerOptions = {}) {
    this.#store = new SQLiteTaskStore(options.databasePath ?? ":memory:");
    this.#engine =
      options.engine ?? new DeterministicAgentEngine(new SystemClock(), "Candy fixture response");
    this.#ownerId = options.ownerId ?? `app-server:${process.pid}`;
    this.#platform = options.platform ?? process.platform;
    this.#attachments = options.attachments;
    this.#bashRunner = options.bashRunner;
    this.#validatorRunner = options.validatorRunner;
    this.#changeTracker =
      options.changeTracker ??
      new ResolvedWorkspaceChangeTracker(
        new GitWorkspaceChangeTracker(),
        new NonGitWorkspaceChangeTracker(),
      );
    this.#activeSecrets = options.activeSecrets;
    this.#applyChanges = options.applyChanges;
    this.#worktreeRoot = options.worktreeRoot;
    this.#worktreeManager = options.worktreeManager;
    this.recoverActiveTasks();
  }

  public get state(): AppServerState {
    return {
      protocolVersion: 1,
      runtimeVersion: "0.0.0",
      executingTasks: [...this.#active.keys()],
    };
  }

  public async dispatch(
    message: ProtocolMessage,
    emit: Emit = () => undefined,
  ): Promise<readonly ProtocolMessage[]> {
    validateProtocolMessage(message);
    if (message.kind !== "command") return [message];
    const existing = this.#store.get(message.taskId);
    this.#commands.accept(message, existing?.revision ?? 0);
    const command = message.command;

    if (command.type === "task.create") {
      if (existing) throw new Error(`Task ${message.taskId} already exists.`);
      const activeSecrets = this.#activeSecrets?.() ?? [];
      if (
        containsAppServerCredentialMaterial(command.prompt) ||
        containsActiveSecret(command.prompt, activeSecrets)
      )
        throw new Error("Provider credentials are forbidden in task prompts.");
      if (command.trustedShell === true && this.#platform !== "darwin")
        throw new Error("Personal Preview Shell is unavailable outside the macOS TUI.");
      if (command.trustedShell === true && this.#bashRunner === undefined)
        throw new Error("Personal Preview Shell is unavailable on this installation.");
      if (command.trustedShell === true && command.approvalProfile !== "auto")
        throw new Error("Personal Preview Shell requires the auto approval profile.");
      if (!path.isAbsolute(command.workspacePath))
        throw new Error("Task workspace must be an absolute path.");
      if (!(await stat(command.workspacePath)).isDirectory())
        throw new Error("Task workspace is not a directory.");
      const workspaceBaseline = await this.#changeTracker.captureBaseline(command.workspacePath);
      if (command.trustedShell === true && workspaceBaseline === undefined)
        throw new Error("Personal Preview Shell requires a Git Task Worktree.");
      let worktreePath: string | undefined;
      if (command.approvalProfile === "auto" && workspaceBaseline !== undefined) {
        const plan = this.planForTask(message.taskId, command.workspacePath, workspaceBaseline);
        try {
          await this.worktreeManager().create(plan);
        } catch (error) {
          throw new Error("Task Worktree creation failed.", { cause: error });
        }
        worktreePath = plan.worktreePath;
        const handoff = new WorkspaceHandoff();
        handoff.startWorktree();
        this.#handoffs.set(message.taskId, handoff);
      }
      const metadata = this.#store.create(
        message.taskId,
        command.approvalProfile,
        this.nextQueueOrder(),
        command.model ?? DEFAULT_CANDY_MODEL,
        command.attachmentIds ?? [],
        command.workspacePath,
        command.validator,
        workspaceBaseline,
        worktreePath,
        command.trustedShell === true,
      );
      this.#prompts.set(message.taskId, command.prompt);
      this.#store.appendTranscript(message.taskId, [{ role: "user", text: command.prompt }]);
      return [
        this.event(message.taskId, metadata.revision, {
          type: "task.created",
          approvalProfile: command.approvalProfile,
          model: metadata.model,
          attachmentIds: metadata.attachmentIds,
        }),
        this.snapshot(metadata),
      ];
    }

    if (command.type === "snapshot") {
      if (existing) {
        const current = await this.ensureBaseline(existing);
        return [await this.workspaceChanges(current), this.snapshot(current)];
      }
      return [
        this.snapshot(
          existing ?? {
            taskId: message.taskId,
            revision: message.expectedRevision,
            state: "queued",
            approvalProfile: "read-only",
            model: DEFAULT_CANDY_MODEL,
            workspacePath: "",
          },
        ),
      ];
    }

    if (!existing) throw new Error(`Task ${message.taskId} does not exist.`);
    if (command.type === "task.reorder") {
      if (message.taskId === command.beforeTaskId)
        throw new Error("A task cannot be reordered before itself.");
      const sourceIndex = this.#pendingRuns.findIndex(({ taskId }) => taskId === message.taskId);
      const targetIndex = this.#pendingRuns.findIndex(
        ({ taskId }) => taskId === command.beforeTaskId,
      );
      if (sourceIndex < 0 || targetIndex < 0)
        throw new Error("Only queued run requests can be reordered.");
      const reordered = this.#store.reorderQueued(message.taskId, command.beforeTaskId);
      const [moved] = this.#pendingRuns.splice(sourceIndex, 1);
      if (moved === undefined) throw new Error("Queued task is unavailable.");
      const insertionIndex = this.#pendingRuns.findIndex(
        ({ taskId }) => taskId === command.beforeTaskId,
      );
      if (insertionIndex < 0) throw new Error("Queued destination is unavailable.");
      this.#pendingRuns.splice(insertionIndex, 0, moved);
      const snapshot = reordered.find((task) => task.taskId === message.taskId);
      return [this.snapshot(snapshot ?? existing)];
    }
    if (command.type === "task.steer") {
      if (existing.state === "completed" || existing.state === "cancelled")
        throw new Error(`Task ${message.taskId} is not steerable.`);
      if (existing.ownerId !== undefined && existing.ownerId !== this.#ownerId)
        return [this.snapshot(existing)];
      const queued = this.#steering.get(message.taskId) ?? [];
      const activeSecrets = this.#activeSecrets?.() ?? [];
      if (
        containsAppServerCredentialMaterial(command.text) ||
        containsActiveSecret(command.text, activeSecrets)
      )
        throw new Error("Provider credentials are forbidden in task steering.");
      this.#steering.set(message.taskId, [...queued, command.text]);
      this.#store.appendTranscript(message.taskId, [{ role: "user", text: command.text }]);
      return [this.snapshot(existing)];
    }
    if (command.type === "task.run" || command.type === "task.resume") {
      if (existing.state === "running") return [this.snapshot(existing)];
      if (
        existing.state !== "queued" &&
        existing.state !== "paused" &&
        existing.state !== "interrupted"
      ) {
        throw new Error(`Task ${message.taskId} is not resumable.`);
      }
      if (this.#active.size >= 3) {
        if (!this.#requestedRuns.has(message.taskId)) {
          this.#requestedRuns.add(message.taskId);
          this.#pendingRuns.push({ taskId: message.taskId, emit });
        }
        return [this.snapshot(existing)];
      }
      const running = this.#store.transition(
        message.taskId,
        message.expectedRevision,
        "running",
        this.#ownerId,
      );
      const startEvents = [this.stateChanged(running, "user"), this.snapshot(running)];
      this.startTask(message.taskId, emit);
      return startEvents;
    }

    if (command.type === "task.cancel" || command.type === "task.pause") {
      if (existing.ownerId !== undefined && existing.ownerId !== this.#ownerId) {
        return [this.snapshot(existing)];
      }
      const active = this.#active.get(message.taskId);
      if (active) {
        active.requestedStop = command.type === "task.pause" ? "paused" : "cancelled";
        active.abort.abort(
          new LongRunningControlError(command.type === "task.pause" ? "user_stop" : "cancelled"),
        );
        await active.done;
        const finished = this.#store.get(message.taskId);
        return finished ? [this.snapshot(finished)] : [];
      }
      const pendingIndex = this.#pendingRuns.findIndex(({ taskId }) => taskId === message.taskId);
      if (pendingIndex >= 0) {
        this.#pendingRuns.splice(pendingIndex, 1);
        this.#requestedRuns.delete(message.taskId);
      }
      const nextState = command.type === "task.pause" ? "paused" : "cancelled";
      this.recordStopProgress(
        message.taskId,
        command.type === "task.pause" ? "user_stop" : "cancelled",
      );
      const updated = this.#store.transition(message.taskId, message.expectedRevision, nextState);
      return [this.stateChanged(updated, "user"), this.snapshot(updated)];
    }

    if (command.type === "workspace.apply") {
      if (existing.state !== "completed")
        throw new Error("Apply Changes requires a completed task.");
      if (existing.ownerId !== undefined)
        throw new Error("Apply Changes requires released task ownership.");
      if (existing.workspaceBaseline === undefined)
        throw new Error("Apply Changes baseline is unavailable.");
      const executionPath = existing.worktreePath ?? existing.workspacePath;
      const reviewed = await this.#changeTracker.inspect(
        executionPath,
        existing.workspaceBaseline,
        [],
      );
      if (!reviewed.available || reviewed.patchTruncated)
        throw new ApplyChangesBlockedError("Apply Changes requires a complete reviewed diff.");
      if (
        !samePathList(command.tracked, reviewed.tracked) ||
        !samePathList(command.untracked, reviewed.untracked)
      ) {
        throw new ApplyChangesBlockedError("Reviewed workspace changed before Apply.");
      }
      const runner = this.#applyChanges ?? new ApplyChangesService(existing.workspacePath);
      const handoff =
        existing.worktreePath === undefined ? undefined : this.#handoffs.get(existing.taskId);
      handoff?.beginApply("allow");
      try {
        await runner.apply(executionPath, {
          targetIsGit: true,
          targetClean: true,
          expectedBase: existing.workspaceBaseline,
          actualBase: existing.workspaceBaseline,
          paths: [...command.tracked, ...command.untracked],
          untrackedPaths: command.untracked,
          patchText: reviewed.patchText,
          activeSecrets: this.#activeSecrets?.() ?? [],
        });
      } catch (error) {
        if (existing.worktreePath !== undefined) this.#handoffs.delete(existing.taskId);
        throw error;
      }
      if (existing.worktreePath !== undefined) {
        await this.worktreeManager().discard(this.planFromMetadata(existing));
        const updated = this.#store.updateWorktree(existing.taskId);
        handoff?.finishApply();
        this.#handoffs.delete(existing.taskId);
        return [this.snapshot(updated)];
      }
      return [this.snapshot(existing)];
    }

    if (command.type === "workspace.discard") {
      if (existing.state !== "completed") throw new Error("Discard requires a completed task.");
      if (existing.ownerId !== undefined)
        throw new Error("Discard requires released task ownership.");
      if (existing.worktreePath === undefined)
        throw new Error("Task has no Task Worktree to discard.");
      await this.worktreeManager().discard(this.planFromMetadata(existing));
      const updated = this.#store.updateWorktree(existing.taskId);
      this.#handoffs.delete(existing.taskId);
      return [this.snapshot(updated)];
    }

    if (command.type === "approval.respond") {
      if (existing.ownerId !== undefined && existing.ownerId !== this.#ownerId)
        return [this.snapshot(existing)];
      if (existing.state !== "waiting_approval")
        throw new Error("Task is not waiting for approval.");
      if (command.approvalId !== approvalIdFor(existing.taskId, existing.revision))
        throw new Error("Approval request is stale.");
      const shellApproval = this.#shellApprovals.get(message.taskId);
      if (shellApproval !== undefined) {
        this.#shellApprovals.delete(message.taskId);
        const active = this.#active.get(message.taskId);
        if (command.decision === "deny") {
          const paused = this.#store.transition(message.taskId, message.expectedRevision, "paused");
          shellApproval.resolve(false);
          active?.abort.abort(new LongRunningControlError("user_stop"));
          return [this.stateChanged(paused, "approval"), this.snapshot(paused)];
        }
        const running = this.#store.transition(
          message.taskId,
          message.expectedRevision,
          "running",
          this.#ownerId,
        );
        shellApproval.resolve(true);
        return [this.stateChanged(running, "approval"), this.snapshot(running)];
      }
      const active = this.#active.get(message.taskId);
      if (active) await active.done;
      if (command.decision === "deny") {
        this.recordStopProgress(message.taskId, "approval_required");
        const paused = this.#store.transition(message.taskId, message.expectedRevision, "paused");
        return [this.stateChanged(paused, "approval"), this.snapshot(paused)];
      }
      const running = this.#store.transition(
        message.taskId,
        message.expectedRevision,
        "running",
        this.#ownerId,
      );
      const startEvents = [this.stateChanged(running, "approval"), this.snapshot(running)];
      this.startTask(message.taskId, emit);
      return startEvents;
    }

    throw new Error("Unsupported app-server command.");
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const metadata of this.#store.list()) {
      if (
        metadata.ownerId !== this.#ownerId ||
        (metadata.state !== "running" && metadata.state !== "waiting_approval")
      )
        continue;
      this.recordCrashProgress(metadata.taskId);
    }
    this.#store.markOwnerInterrupted(this.#ownerId);
    for (const active of this.#active.values())
      active.abort.abort(new LongRunningControlError("crash_interrupted"));
    const activeRuns = [...this.#active.values()].map((active) => active.done);
    if (activeRuns.length === 0) this.closeStore();
    else void Promise.allSettled(activeRuns).then(() => this.closeStore());
  }

  private startTask(taskId: string, emit: Emit): void {
    const abort = new AbortController();
    const active: ActiveTask = { abort, done: Promise.resolve() };
    const done = this.runTask(taskId, active, emit);
    active.done = done;
    this.#active.set(taskId, active);
  }

  private async runTask(taskId: string, active: ActiveTask, emit: Emit): Promise<void> {
    try {
      const current = this.#store.get(taskId);
      if (!current) throw new Error("Task metadata is unavailable.");
      if (!this.ownsExecution(current)) throw new LongRunningControlError("ownership_lost");
      if (!path.isAbsolute(current.workspacePath))
        throw new Error("Task workspace is unavailable after restart.");
      const executionPath = current.worktreePath ?? current.workspacePath;
      const prompt =
        this.#prompts.get(taskId) ?? (await this.#engine.recoverPrompt?.(taskId, executionPath));
      if (prompt === undefined) throw new Error("Task prompt is unavailable after restart.");
      if (current.attachmentIds.length > MAX_TASK_ATTACHMENT_COUNT)
        throw new Error("Task attachment count exceeds Candy's limit.");
      const images =
        current.attachmentIds.length === 0
          ? undefined
          : this.#attachments
            ? await loadTaskAttachments(this.#attachments, current.attachmentIds)
            : (() => {
                throw new Error("Attachment storage is unavailable after restart.");
              })();
      const runTurn = (): Promise<void> => {
        const steering = this.consumeSteering(taskId);
        return this.runAgentTurn(
          taskId,
          current,
          steering ?? prompt,
          images,
          active.abort.signal,
          emit,
        );
      };

      if (current.approvalProfile === "auto" && current.validator !== undefined) {
        const longRunning = new LongRunningTaskRunner(3, 2);
        const result = await longRunning.run(
          async (_round, signal) => {
            try {
              await runTurn();
            } catch (error) {
              if (error instanceof LongRunningControlError) throw error;
              const code = taskErrorCode(error, signal);
              if (code === "needs_credentials" || code === "provider_error")
                throw new LongRunningControlError("provider_failure");
              throw error;
            }
            if (signal.aborted)
              throw signal.reason instanceof Error
                ? signal.reason
                : new LongRunningControlError("cancelled");
            const afterTurn = this.#store.get(taskId);
            if (this.ownsExecution(afterTurn)) emit(await this.workspaceChanges(afterTurn));
            else throw new LongRunningControlError("ownership_lost");
          },
          {
            run: (signal) => {
              const metadata = this.#store.get(taskId);
              if (!metadata) throw new Error("Task metadata is unavailable.");
              return this.runValidator(taskId, metadata, executionPath, signal, emit);
            },
          },
          active.abort.signal,
          {
            store: {
              record: (progress) => {
                if (!this.ownsExecution(this.#store.get(taskId))) return;
                this.#store.recordRun({ taskId, ...progress });
                const metadata = this.#store.get(taskId);
                if (this.ownsExecution(metadata) && !this.#closed) emit(this.snapshot(metadata));
              },
            },
          },
        );
        const metadata = this.#store.get(taskId);
        if (!this.ownsExecution(metadata)) return;
        if (result.completed) {
          const completed = this.#store.transition(taskId, metadata.revision, "completed");
          emit(this.stateChanged(completed, "validator"));
          emit(this.snapshot(completed));
        } else {
          const stopped = this.#store.transition(
            taskId,
            metadata.revision,
            longRunningState(result.stopReason),
          );
          const errorCode = longRunningErrorCode(result.stopReason);
          if (errorCode !== undefined)
            emit(this.event(taskId, stopped.revision, { type: "task.error", code: errorCode }));
          emit(this.stateChanged(stopped, longRunningStateReason(result.stopReason)));
          emit(this.snapshot(stopped));
        }
        return;
      }

      await runTurn();
      const metadata = this.#store.get(taskId);
      if (this.ownsExecution(metadata)) {
        emit(await this.workspaceChanges(metadata));
        if (metadata.validator !== undefined) {
          const result = await this.runValidator(
            taskId,
            metadata,
            executionPath,
            active.abort.signal,
            emit,
          );
          if (!result.ok) throw new Error("Validator did not pass.");
        }
        const completed = this.#store.transition(taskId, metadata.revision, "completed");
        emit(this.stateChanged(completed, "validator"));
        emit(this.snapshot(completed));
      }
    } catch (error) {
      if (this.#closed) return;
      const metadata = this.#store.get(taskId);
      if (this.ownsExecution(metadata)) {
        const nextState =
          active.requestedStop ?? (active.abort.signal.aborted ? "interrupted" : "interrupted");
        const interrupted = this.#store.transition(taskId, metadata.revision, nextState);
        emit(
          this.event(taskId, interrupted.revision, {
            type: "task.error",
            code:
              nextState === "cancelled" ? "cancelled" : taskErrorCode(error, active.abort.signal),
          }),
        );
        emit(
          this.stateChanged(interrupted, active.requestedStop === "cancelled" ? "user" : "error"),
        );
        emit(this.snapshot(interrupted));
      }
      void error;
    } finally {
      this.#active.delete(taskId);
      this.#requestedRuns.delete(taskId);
      const finalState = this.#storeClosed ? undefined : this.#store.get(taskId)?.state;
      if (finalState === "completed" || finalState === "cancelled") this.#steering.delete(taskId);
      if (!this.#closed) this.pumpPendingRuns();
    }
  }

  private async runAgentTurn(
    taskId: string,
    metadata: TaskMetadata,
    prompt: string,
    images: Awaited<ReturnType<AttachmentStore["getImagePayload"]>>[] | undefined,
    signal: AbortSignal,
    emit: Emit,
  ): Promise<void> {
    const executionPath = metadata.worktreePath ?? metadata.workspacePath;
    const trustedGitCommonDirectory =
      metadata.trustedShell && this.#engine instanceof PiAppServerEngine
        ? await resolveGitCommonDirectory(metadata.workspacePath)
        : undefined;
    for await (const observation of this.#engine.runTurn(
      {
        taskId,
        prompt,
        model: metadata.model,
        cwd: executionPath,
        approvalProfile: metadata.approvalProfile,
        activeSecrets: this.#activeSecrets?.() ?? [],
        ...(images === undefined ? {} : { images }),
        ...(metadata.trustedShell && metadata.worktreePath !== undefined
          ? {
              trustedShell: true,
              ...(trustedGitCommonDirectory === undefined ? {} : { trustedGitCommonDirectory }),
              shellApproval: (
                request: {
                  readonly command: string;
                  readonly cwd: string;
                  readonly timeout?: number;
                },
                approvalSignal: AbortSignal,
              ) => this.requestShellApproval(taskId, request, approvalSignal, emit),
            }
          : {}),
      },
      signal,
    )) {
      const current = this.#store.get(taskId);
      if (!this.ownsExecution(current)) throw new LongRunningControlError("ownership_lost");
      const rawEvent = observationToEvent(taskId, current.revision, observation);
      const event =
        rawEvent?.type === "assistant.delta" || rawEvent?.type === "assistant.thinking.delta"
          ? {
              ...rawEvent,
              text: sanitizeAppServerText(rawEvent.text, this.#activeSecrets?.() ?? []),
            }
          : rawEvent;
      if (event) {
        if (event.type === "assistant.delta" && this.ownsExecution(this.#store.get(taskId)))
          this.#store.appendTranscript(taskId, [{ role: "assistant", text: event.text }]);
        emit(this.event(taskId, current.revision, event));
      }
    }
  }

  private requestShellApproval(
    taskId: string,
    request: { readonly command: string; readonly cwd: string; readonly timeout?: number },
    signal: AbortSignal,
    emit: Emit,
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const current = this.#store.get(taskId);
    if (!this.ownsExecution(current) || current.worktreePath === undefined)
      return Promise.resolve(false);
    if (path.resolve(request.cwd) !== path.resolve(current.worktreePath))
      throw new Error("Trusted Shell approval cwd must be the Task Worktree.");
    if (request.command.length === 0 || /[\0\r\n]/u.test(request.command))
      throw new Error("Trusted Shell command is invalid.");
    if (
      request.timeout !== undefined &&
      (!Number.isFinite(request.timeout) || request.timeout <= 0)
    )
      throw new Error("Trusted Shell timeout is invalid.");
    const activeSecrets = this.#activeSecrets?.() ?? [];
    if (
      containsAppServerCredentialMaterial(request.command) ||
      activeSecrets.some((secret) => secret.length > 0 && request.command.includes(secret))
    )
      throw new Error("Provider credentials are forbidden in Trusted Shell commands.");
    const waiting = this.#store.transition(
      taskId,
      current.revision,
      "waiting_approval",
      this.#ownerId,
    );
    const approvalId = approvalIdFor(taskId, waiting.revision);
    let settled = false;
    let resolveApproval!: (approved: boolean) => void;
    const result = new Promise<boolean>((resolve) => {
      resolveApproval = (approved) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(approved);
      };
    });
    const onAbort = (): void => {
      this.#shellApprovals.delete(taskId);
      resolveApproval(false);
      const latest = this.#store.get(taskId);
      if (latest?.state === "waiting_approval") {
        const reason =
          signal.reason instanceof LongRunningControlError
            ? signal.reason.stopReason
            : "crash_interrupted";
        const nextState =
          reason === "cancelled" ? "cancelled" : reason === "user_stop" ? "paused" : "interrupted";
        const stopped = this.#store.transition(taskId, latest.revision, nextState);
        emit(
          this.stateChanged(
            stopped,
            nextState === "cancelled" || nextState === "paused" ? "user" : "error",
          ),
        );
        emit(this.snapshot(stopped));
      }
    };
    this.#shellApprovals.set(taskId, { request, approvalId, resolve: resolveApproval });
    signal.addEventListener("abort", onAbort, { once: true });
    emit(this.stateChanged(waiting, "approval"));
    emit(this.snapshot(waiting));
    return result;
  }

  private async runValidator(
    taskId: string,
    metadata: TaskMetadata,
    executionPath: string,
    signal: AbortSignal,
    emit: Emit,
  ): Promise<ValidatorResult> {
    if (signal.aborted)
      throw signal.reason instanceof Error
        ? signal.reason
        : new LongRunningControlError("cancelled");
    if (!this.ownsExecution(this.#store.get(taskId)))
      throw new LongRunningControlError("ownership_lost");
    if (metadata.validator === undefined) throw new Error("Task validator is unavailable.");
    if (this.#validatorRunner === undefined)
      throw new Error("Validator execution is unavailable on this installation.");
    emit(this.event(taskId, metadata.revision, { type: "tool.started", tool: "validator" }));
    const result = await this.#validatorRunner.run(metadata.validator, executionPath, signal);
    if (!this.ownsExecution(this.#store.get(taskId)))
      throw new LongRunningControlError("ownership_lost");
    this.#store.appendTranscript(taskId, [
      { role: "tool", text: `validator: ${result.ok ? "ok" : "error"}` },
    ]);
    emit(
      this.event(taskId, metadata.revision, {
        type: "tool.completed",
        tool: "validator",
        ok: result.ok,
      }),
    );
    const activeSecrets = this.#activeSecrets?.() ?? [];
    const evidence = sanitizeEvidenceSummary(
      result.evidence ?? (result.ok ? "validator passed" : "validator failed"),
      activeSecrets,
    );
    return {
      ok: result.ok,
      fingerprint: sanitizeEvidenceSummary(
        result.fingerprint ?? `${result.ok ? "ok" : "error"}:${evidence}`,
        activeSecrets,
      ),
      evidence,
      durationMs: result.durationMs ?? 0,
    };
  }

  private recoverActiveTasks(): void {
    const active = this.#store
      .list()
      .filter((metadata) => metadata.state === "running" || metadata.state === "waiting_approval");
    for (const metadata of active) this.recordCrashProgress(metadata.taskId);
    if (active.length > 0) this.#store.markActiveInterrupted();
  }

  private recordCrashProgress(taskId: string): void {
    const previous = this.#store.getRun(taskId);
    this.#store.recordRun({
      taskId,
      rounds: previous?.rounds ?? 0,
      evidenceCount: previous?.evidenceCount ?? 0,
      completed: false,
      stopReason: "crash_interrupted",
      ...(previous?.lastFingerprintHash === undefined
        ? {}
        : { lastFingerprintHash: previous.lastFingerprintHash }),
      ...(previous?.evidenceSummary === undefined
        ? {}
        : { evidenceSummary: previous.evidenceSummary }),
    });
  }

  private recordStopProgress(
    taskId: string,
    stopReason: Extract<
      TaskProgress["stopReason"],
      "cancelled" | "user_stop" | "approval_required"
    >,
  ): void {
    const previous = this.#store.getRun(taskId);
    this.#store.recordRun({
      taskId,
      rounds: previous?.rounds ?? 0,
      evidenceCount: previous?.evidenceCount ?? 0,
      completed: false,
      stopReason,
      ...(previous?.lastFingerprintHash === undefined
        ? {}
        : { lastFingerprintHash: previous.lastFingerprintHash }),
      ...(previous?.evidenceSummary === undefined
        ? {}
        : { evidenceSummary: previous.evidenceSummary }),
    });
  }

  private consumeSteering(taskId: string): string | undefined {
    const queued = this.#steering.get(taskId);
    if (queued === undefined || queued.length === 0) return undefined;
    this.#steering.delete(taskId);
    return queued.join("\n\n");
  }

  private ownsExecution(metadata: TaskMetadata | undefined): metadata is TaskMetadata {
    return (
      metadata !== undefined &&
      metadata.ownerId === this.#ownerId &&
      (metadata.state === "running" || metadata.state === "waiting_approval")
    );
  }

  private closeStore(): void {
    if (this.#storeClosed) return;
    this.#storeClosed = true;
    this.#store.close();
  }

  private pumpPendingRuns(): void {
    if (this.#closed || this.#active.size >= 3) return;
    const next = this.#pendingRuns.shift();
    if (!next) return;
    this.#requestedRuns.delete(next.taskId);
    const metadata = this.#store.get(next.taskId);
    if (!metadata || !["queued", "paused", "interrupted"].includes(metadata.state)) {
      this.pumpPendingRuns();
      return;
    }
    const running = this.#store.transition(
      next.taskId,
      metadata.revision,
      "running",
      this.#ownerId,
    );
    next.emit(this.stateChanged(running, "user"));
    next.emit(this.snapshot(running));
    this.startTask(next.taskId, next.emit);
  }

  private nextQueueOrder(): number {
    return this.#store.queued().reduce((max, item) => Math.max(max, item.queueOrder ?? 0), 0) + 1;
  }

  private worktreeManager(): TaskWorktreeManager {
    if (this.#worktreeManager !== undefined) return this.#worktreeManager;
    if (this.#worktreeRoot === undefined)
      throw new Error("Task Worktree root is unavailable on this installation.");
    this.#worktreeManager = new GitWorktreeManager(this.#worktreeRoot);
    return this.#worktreeManager;
  }

  private planForTask(taskId: string, workspacePath: string, baseCommit: string): GitWorktreePlan {
    if (this.#worktreeRoot === undefined)
      throw new Error("Task Worktree root is unavailable on this installation.");
    return planGitWorktree(
      workspacePath,
      path.join(this.#worktreeRoot, taskId),
      taskId,
      baseCommit,
    );
  }

  private planFromMetadata(metadata: TaskMetadata): GitWorktreePlan {
    if (metadata.worktreePath === undefined)
      throw new Error("Task has no associated Task Worktree.");
    if (metadata.workspaceBaseline === undefined)
      throw new Error("Task Worktree baseline is unavailable.");
    return planGitWorktree(
      metadata.workspacePath,
      metadata.worktreePath,
      metadata.taskId,
      metadata.workspaceBaseline,
    );
  }

  private async workspaceChanges(metadata: TaskMetadata): Promise<EventEnvelope> {
    const activeSecrets = this.#activeSecrets?.() ?? [];
    const changes = await this.#changeTracker.inspect(
      metadata.worktreePath ?? metadata.workspacePath,
      metadata.workspaceBaseline,
      activeSecrets,
    );
    return this.event(metadata.taskId, metadata.revision, {
      type: "workspace.changes",
      available: changes.available,
      tracked: changes.tracked,
      untracked: changes.untracked,
      patchText: redactWorkspacePatch(changes.patchText, activeSecrets),
      patchTruncated: changes.patchTruncated,
    });
  }

  private async ensureBaseline(metadata: TaskMetadata): Promise<TaskMetadata> {
    if (metadata.workspaceBaseline !== undefined) return metadata;
    const baseline = await this.#changeTracker.captureBaseline(metadata.workspacePath);
    return this.#store.updateBaseline(metadata.taskId, baseline);
  }

  private snapshot(metadata: TaskMetadata | TaskSnapshot): EventEnvelope {
    const worktreePath = "worktreePath" in metadata ? metadata.worktreePath : undefined;
    const progress = "taskId" in metadata ? this.#store.getRun(metadata.taskId) : undefined;
    const transcript = "taskId" in metadata ? this.#store.transcript(metadata.taskId) : undefined;
    return this.event(metadata.taskId, metadata.revision, {
      type: "snapshot",
      snapshot: {
        taskId: metadata.taskId,
        revision: metadata.revision,
        state: metadata.state === "queued" ? "queued" : metadata.state,
        ...(metadata.approvalProfile === undefined
          ? {}
          : { approvalProfile: metadata.approvalProfile }),
        ...(metadata.model === undefined ? {} : { model: metadata.model }),
        ...(metadata.attachmentIds === undefined ? {} : { attachmentIds: metadata.attachmentIds }),
        ...(metadata.workspacePath === undefined ? {} : { workspacePath: metadata.workspacePath }),
        ...(metadata.workspaceBaseline === undefined
          ? {}
          : { workspaceBaseline: metadata.workspaceBaseline }),
        workspaceState: worktreePath === undefined ? "local" : "worktree",
        ...(worktreePath === undefined ? {} : { worktreePath }),
        ...(metadata.ownerId === undefined ? {} : { ownerId: metadata.ownerId }),
        ...(metadata.state === "waiting_approval"
          ? { approvalId: approvalIdFor(metadata.taskId, metadata.revision) }
          : {}),
        ...(metadata.trustedShell ? { trustedShell: true } : {}),
        ...(this.#shellApprovals.get(metadata.taskId)?.request === undefined
          ? {}
          : { shellApproval: this.#shellApprovals.get(metadata.taskId)!.request }),
        ...(progress === undefined ? {} : { progress: toTaskProgress(progress) }),
        ...(transcript === undefined ? {} : { transcript }),
      },
    });
  }

  private stateChanged(
    metadata: TaskMetadata,
    reason: "user" | "owner_lost" | "approval" | "validator" | "error",
  ): EventEnvelope {
    return this.event(metadata.taskId, metadata.revision, {
      type: "task.state_changed",
      state: metadata.state,
      reason,
    });
  }

  private event(taskId: string, revision: number, event: RuntimeEvent): EventEnvelope {
    const sequence = (this.#sequences.get(taskId) ?? 0) + 1;
    this.#sequences.set(taskId, sequence);
    return { v: 1, kind: "event", taskId, sequence, revision, event };
  }
}

function toTaskProgress(progress: {
  readonly rounds: number;
  readonly evidenceCount: number;
  readonly completed: boolean;
  readonly stopReason: TaskProgress["stopReason"];
  readonly lastFingerprintHash?: string;
  readonly evidenceSummary?: string;
}): TaskProgress {
  return {
    rounds: progress.rounds,
    evidenceCount: progress.evidenceCount,
    completed: progress.completed,
    stopReason: progress.stopReason,
    ...(progress.lastFingerprintHash === undefined
      ? {}
      : { lastFingerprintHash: progress.lastFingerprintHash }),
    ...(progress.evidenceSummary === undefined
      ? {}
      : { evidenceSummary: progress.evidenceSummary }),
  };
}

function approvalIdFor(taskId: string, revision: number): string {
  return `approval:${taskId}:${revision}`;
}

function longRunningState(
  stopReason: TaskProgress["stopReason"],
): "paused" | "waiting_approval" | "interrupted" | "cancelled" {
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "approval_required") return "waiting_approval";
  if (
    stopReason === "user_stop" ||
    stopReason === "budget_exhausted" ||
    stopReason === "stall_detected"
  )
    return "paused";
  return "interrupted";
}

function longRunningStateReason(
  stopReason: TaskProgress["stopReason"],
): "user" | "owner_lost" | "approval" | "validator" | "error" {
  if (stopReason === "cancelled" || stopReason === "user_stop") return "user";
  if (stopReason === "approval_required") return "approval";
  if (stopReason === "budget_exhausted" || stopReason === "stall_detected") return "validator";
  if (stopReason === "ownership_lost") return "owner_lost";
  return "error";
}

function longRunningErrorCode(
  stopReason: TaskProgress["stopReason"],
): "cancelled" | "needs_credentials" | "provider_error" | "runtime_error" | undefined {
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "provider_failure") return "provider_error";
  if (
    stopReason === "error" ||
    stopReason === "crash_interrupted" ||
    stopReason === "ownership_lost"
  )
    return "runtime_error";
  return undefined;
}

function observationToEvent(
  _taskId: string,
  _revision: number,
  observation: AgentObservation,
): RuntimeEvent | undefined {
  if (observation.type === "assistant.delta")
    return { type: "assistant.delta", text: observation.text };
  if (observation.type === "assistant.thinking.delta")
    return { type: "assistant.thinking.delta", text: observation.text };
  if (observation.type === "tool.started") return { type: "tool.started", tool: observation.tool };
  if (observation.type === "tool.completed")
    return { type: "tool.completed", tool: observation.tool, ok: observation.ok };
  return undefined;
}

function taskErrorCode(
  error: unknown,
  signal: AbortSignal,
): "cancelled" | "needs_credentials" | "provider_error" | "runtime_error" {
  if (signal.aborted) return "cancelled";
  if (error instanceof Error) {
    const code = (error as Error & { readonly code?: unknown }).code;
    if (code === "needs_credentials") return code;
    if (code === "unapproved_endpoint" || code === "malformed_stream" || code === "provider_error")
      return "provider_error";
  }
  return "runtime_error";
}

function redactWorkspacePatch(value: string, activeSecrets: readonly string[]): string {
  return activeSecrets.reduce(
    (result, secret) => (secret.length > 0 ? result.split(secret).join("[REDACTED]") : result),
    value.slice(0, 1_048_576),
  );
}

function containsAppServerCredentialMaterial(value: string): boolean {
  return /(?:Bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,})/u.test(
    value,
  );
}

function containsActiveSecret(value: string, activeSecrets: readonly string[]): boolean {
  return activeSecrets.some((secret) => secret.length > 0 && value.includes(secret));
}

function sanitizeAppServerText(value: string, activeSecrets: readonly string[]): string {
  return sanitizeEvidenceSummary(value, activeSecrets);
}

function sanitizeEvidenceSummary(value: string, activeSecrets: readonly string[]): string {
  return redactWorkspacePatch(value, activeSecrets)
    .replace(
      /(?:Bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,})/gu,
      "[REDACTED]",
    )
    .slice(0, 4_096);
}

function samePathList(left: readonly string[], right: readonly string[]): boolean {
  const sort = (paths: readonly string[]): string[] => [...paths].sort();
  const a = sort(left);
  const b = sort(right);
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function createDeterministicRecoveryEngine(): RecoverableAgentEngine {
  const engine = new DeterministicAgentEngine(
    new SystemClock(),
    "Candy deterministic recovery fixture",
  );
  return {
    runTurn: (input, signal) => engine.runTurn(input, signal),
    recoverPrompt: async () => "Candy deterministic recovery fixture prompt",
  };
}

/** Test-only engine used by the packaged macOS long-running smoke. It exercises
 * the production controller and LongRunningTaskRunner at an approval boundary;
 * it is not a second task workflow or a production fallback. */
function createLongRunningSmokeEngine(): RecoverableAgentEngine {
  let firstTurn = true;
  return {
    async *runTurn(input: AgentTurnInput, signal: AbortSignal) {
      if (firstTurn) {
        firstTurn = false;
        throw new LongRunningControlError("approval_required");
      }
      if (signal.aborted) throw signal.reason;
      yield { type: "assistant.delta" as const, text: input.prompt };
      if (signal.aborted) throw signal.reason;
      yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
    },
    recoverPrompt: async () => "Candy packaged long-running fixture",
  };
}

function createCodingJourneyEngine(): RecoverableAgentEngine {
  return {
    async *runTurn(input: AgentTurnInput) {
      yield { type: "assistant.delta" as const, text: "inspecting and editing the fixture" };
      if (input.cwd !== undefined) {
        await writeFile(path.join(input.cwd, "README.md"), "changed by task\n");
        await writeFile(path.join(input.cwd, "new.txt"), "untracked by task\n");
      }
      yield { type: "turn.completed", taskId: input.taskId, at: Date.now() };
    },
    recoverPrompt: async () => "Candy packaged coding-journey fixture",
  };
}

export function runAppServer(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): void {
  const paths = resolveAppPaths(resolveDefaultAppDataRoot());
  const sandboxRunner = resolveNativeProcessRunnerPath(import.meta.url);
  const commandValidator =
    sandboxRunner === undefined
      ? undefined
      : new CommandValidator(new NativeProcessRunner(sandboxRunner));
  const deterministicRecoverySmoke = process.env.CANDY_DETERMINISTIC_RECOVERY_SMOKE === "1";
  const longRunningSmoke = process.env.CANDY_LONG_RUNNING_SMOKE === "1";
  const codingJourneySmoke = process.env.CANDY_CODING_JOURNEY_SMOKE === "1";
  const smokeEngine = longRunningSmoke || codingJourneySmoke || deterministicRecoverySmoke;
  const controller = new AppServerController({
    databasePath: path.join(paths.state, "tasks.sqlite"),
    attachments: new AttachmentStore(paths.attachments, Date.now, (content) =>
      containsActiveProviderSecret(content, resolveActiveProviderSecrets()),
    ),
    engine: codingJourneySmoke
      ? createCodingJourneyEngine()
      : longRunningSmoke
        ? createLongRunningSmokeEngine()
        : deterministicRecoverySmoke
          ? createDeterministicRecoveryEngine()
          : new PiAppServerEngine(
              new PiAgentEngine(
                paths.sessions,
                async () => {
                  const lease = resolveCredential("deepseek");
                  return lease ? { secret: lease.value, release: lease.release } : undefined;
                },
                "deepseek",
                process.platform === "win32" && sandboxRunner !== undefined
                  ? new NativeProcessRunner(sandboxRunner)
                  : undefined,
              ),
              new PiAgentEngine(
                paths.sessions,
                async () => {
                  const lease = resolveCredential("minimax-cn");
                  return lease ? { secret: lease.value, release: lease.release } : undefined;
                },
                "minimax-cn",
                process.platform === "win32" && sandboxRunner !== undefined
                  ? new NativeProcessRunner(sandboxRunner)
                  : undefined,
              ),
            ),
    ownerId: `app-server:${process.pid}`,
    ...(smokeEngine ? {} : { activeSecrets: resolveActiveProviderSecrets }),
    worktreeRoot: paths.worktrees,
    ...(process.platform === "win32" && sandboxRunner !== undefined
      ? { bashRunner: new NativeProcessRunner(sandboxRunner) }
      : {}),
    ...(sandboxRunner === undefined
      ? {}
      : {
          validatorRunner: {
            run: (command, workspace, signal) =>
              commandValidator?.run(
                command,
                workspace,
                signal,
                {},
                resolveActiveProviderSecrets(),
              ) ??
              Promise.reject(new Error("Validator execution is unavailable on this installation.")),
          },
        }),
  });
  const write = (message: ProtocolMessage): void => {
    stdout.write(encodeJsonLine(message));
  };
  void (async () => {
    try {
      for await (const message of decodeJsonLines(stdin)) {
        try {
          const responses = await controller.dispatch(message, write);
          responses.forEach(write);
        } catch {
          stdout.write('{"v":1,"kind":"error","code":"invalid_message"}\n');
        }
      }
    } finally {
      controller.close();
    }
  })();
}

function resolveActiveProviderSecrets(): readonly string[] {
  const secrets: string[] = [];
  for (const name of ["deepseek", "minimax-cn"] as const) {
    const lease = resolveCredential(name);
    if (!lease) continue;
    secrets.push(lease.value);
    lease.release();
  }
  return secrets;
}

async function loadTaskAttachments(
  store: AttachmentStore,
  ids: readonly string[],
): Promise<Awaited<ReturnType<AttachmentStore["getImagePayload"]>>[]> {
  const images: Awaited<ReturnType<AttachmentStore["getImagePayload"]>>[] = [];
  let totalBytes = 0;
  for (const id of ids) {
    const image = await store.getImagePayload(id);
    totalBytes += Buffer.byteLength(image.data, "base64");
    if (totalBytes > MAX_TASK_ATTACHMENT_BYTES)
      throw new Error("Task attachments exceed Candy's aggregate byte limit.");
    images.push(image);
  }
  return images;
}

function containsActiveProviderSecret(
  content: Uint8Array,
  activeSecrets: readonly string[],
): boolean {
  const bytes = Buffer.from(content);
  return activeSecrets.some(
    (secret) => secret.length > 0 && bytes.includes(Buffer.from(secret, "utf8")),
  );
}

function mapPiObservation(observation: PiAgentObservation): AgentObservation | undefined {
  if (observation.type === "turn.started")
    return { type: "turn.started", taskId: observation.taskId, at: Date.now() };
  if (observation.type === "assistant.delta")
    return { type: "assistant.delta", text: observation.text };
  if (observation.type === "assistant.thinking.delta")
    return { type: "assistant.thinking.delta", text: observation.text };
  if (observation.type === "tool.started")
    return { type: "tool.started", taskId: observation.taskId, tool: observation.tool };
  if (observation.type === "tool.completed")
    return {
      type: "tool.completed",
      taskId: observation.taskId,
      tool: observation.tool,
      ok: observation.ok,
    };
  if (observation.type === "turn.completed")
    return { type: "turn.completed", taskId: observation.taskId, at: Date.now() };
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAppServer(process.stdin, process.stdout);
}
