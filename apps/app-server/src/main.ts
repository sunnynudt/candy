import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolveAppPaths,
  resolveCredential,
  resolveDefaultAppDataRoot,
  SQLiteTaskStore,
  SystemClock,
  type CandyModelId,
  DEFAULT_CANDY_MODEL,
  type TaskMetadata,
} from "@candy/platform";
import { PiAgentEngine, type PiAgentEngineInput, type PiAgentObservation } from "@candy/pi-adapter";
import {
  CommandLedger,
  decodeJsonLine,
  encodeJsonLine,
  validateProtocolMessage,
  type CommandEnvelope,
  type EventEnvelope,
  type ProtocolMessage,
  type RuntimeEvent,
  type TaskSnapshot,
} from "@candy/protocol";
import {
  ApplyChangesBlockedError,
  ApplyChangesService,
  DeterministicAgentEngine,
  AttachmentStore,
  GitWorkspaceChangeTracker,
  MacSandboxRunner,
  MacSandboxValidator,
  type AgentEngine,
  type AgentObservation,
  type AgentTurnInput,
  type ApplyChangesInput,
  type RecoverableAgentEngine,
  type MacSandboxValidatorCommand,
  type WorkspaceChangeTracker,
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
    };
    const engine = model === "MiniMax-M3" ? this.minimax : this.deepseek;
    for await (const observation of engine.runTurn(piInput, signal)) {
      yield mapPiObservation(observation);
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
  readonly engine?: AgentEngine;
  readonly ownerId?: string;
  readonly attachments?: AttachmentStore;
  readonly validatorRunner?: AppServerValidator;
  readonly changeTracker?: WorkspaceChangeTracker;
  readonly activeSecrets?: () => readonly string[];
  readonly applyChanges?: ApplyChangesRunner;
}

interface AppServerValidator {
  run(
    command: MacSandboxValidatorCommand,
    workspace: string,
    signal: AbortSignal,
  ): Promise<{ readonly ok: boolean }>;
}

interface ApplyChangesRunner {
  apply(sourceRoot: string, input: ApplyChangesInput): Promise<"applied">;
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

/**
 * Durable task command loop used by Desktop and the app-server smoke path.
 * Prompts remain in the Pi-owned session path in the real engine; this
 * deterministic controller keeps the fixture prompt in memory only.
 */
export class AppServerController {
  readonly #store: SQLiteTaskStore;
  readonly #engine: RecoverableAgentEngine;
  readonly #ownerId: string;
  readonly #attachments: AttachmentStore | undefined;
  readonly #validatorRunner: AppServerValidator | undefined;
  readonly #changeTracker: WorkspaceChangeTracker;
  readonly #activeSecrets: (() => readonly string[]) | undefined;
  readonly #applyChanges: ApplyChangesRunner | undefined;
  readonly #commands = new CommandLedger();
  readonly #prompts = new Map<string, string>();
  readonly #active = new Map<string, ActiveTask>();
  readonly #pendingRuns: PendingRun[] = [];
  readonly #requestedRuns = new Set<string>();
  readonly #sequences = new Map<string, number>();
  #closed = false;

  public constructor(options: AppServerControllerOptions = {}) {
    this.#store = new SQLiteTaskStore(options.databasePath ?? ":memory:");
    this.#engine =
      options.engine ?? new DeterministicAgentEngine(new SystemClock(), "Candy fixture response");
    this.#ownerId = options.ownerId ?? `app-server:${process.pid}`;
    this.#attachments = options.attachments;
    this.#validatorRunner = options.validatorRunner;
    this.#changeTracker = options.changeTracker ?? new GitWorkspaceChangeTracker();
    this.#activeSecrets = options.activeSecrets;
    this.#applyChanges = options.applyChanges;
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
      if (!path.isAbsolute(command.workspacePath))
        throw new Error("Task workspace must be an absolute path.");
      if (!(await stat(command.workspacePath)).isDirectory())
        throw new Error("Task workspace is not a directory.");
      const workspaceBaseline = await this.#changeTracker.captureBaseline(command.workspacePath);
      const metadata = this.#store.create(
        message.taskId,
        command.approvalProfile,
        this.nextQueueOrder(),
        command.model ?? DEFAULT_CANDY_MODEL,
        command.attachmentIds ?? [],
        command.workspacePath,
        command.validator,
        workspaceBaseline,
      );
      this.#prompts.set(message.taskId, command.prompt);
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
          new Error(command.type === "task.pause" ? "Task paused." : "Task cancelled."),
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
      const reviewed = await this.#changeTracker.inspect(
        existing.workspacePath,
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
      await runner.apply(existing.workspacePath, {
        targetIsGit: true,
        targetClean: true,
        expectedBase: existing.workspaceBaseline,
        actualBase: existing.workspaceBaseline,
        paths: [...command.tracked, ...command.untracked],
        untrackedPaths: command.untracked,
        patchText: reviewed.patchText,
        activeSecrets: this.#activeSecrets?.() ?? [],
      });
      return [this.snapshot(existing)];
    }

    if (command.type === "approval.respond") {
      return [this.snapshot(existing)];
    }

    throw new Error("Unsupported app-server command.");
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.markOwnerInterrupted(this.#ownerId);
    for (const active of this.#active.values()) active.abort.abort(new Error("App-server closed."));
    this.#store.close();
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
      if (!path.isAbsolute(current.workspacePath))
        throw new Error("Task workspace is unavailable after restart.");
      const prompt =
        this.#prompts.get(taskId) ??
        (await this.#engine.recoverPrompt?.(taskId, current.workspacePath));
      if (prompt === undefined) throw new Error("Task prompt is unavailable after restart.");
      const images =
        current.attachmentIds.length === 0
          ? undefined
          : this.#attachments
            ? await Promise.all(
                current.attachmentIds.map((id) => this.#attachments!.getImagePayload(id)),
              )
            : (() => {
                throw new Error("Attachment storage is unavailable after restart.");
              })();
      for await (const observation of this.#engine.runTurn(
        {
          taskId,
          prompt,
          model: current.model,
          cwd: current.workspacePath,
          approvalProfile: current.approvalProfile,
          ...(images === undefined ? {} : { images }),
        },
        active.abort.signal,
      )) {
        const metadata = this.#store.get(taskId);
        if (!metadata || metadata.state !== "running") break;
        const event = observationToEvent(taskId, metadata.revision, observation);
        if (event) emit(this.event(taskId, metadata.revision, event));
      }
      const metadata = this.#store.get(taskId);
      if (metadata?.state === "running") {
        emit(await this.workspaceChanges(metadata));
        if (metadata.validator !== undefined) {
          if (this.#validatorRunner === undefined)
            throw new Error("Validator execution is unavailable on this installation.");
          emit(this.event(taskId, metadata.revision, { type: "tool.started", tool: "validator" }));
          const result = await this.#validatorRunner.run(
            metadata.validator,
            metadata.workspacePath,
            active.abort.signal,
          );
          emit(
            this.event(taskId, metadata.revision, {
              type: "tool.completed",
              tool: "validator",
              ok: result.ok,
            }),
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
      if (metadata?.state === "running") {
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
      if (!this.#closed) this.pumpPendingRuns();
    }
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

  private async workspaceChanges(metadata: TaskMetadata): Promise<EventEnvelope> {
    const activeSecrets = this.#activeSecrets?.() ?? [];
    const changes = await this.#changeTracker.inspect(
      metadata.workspacePath,
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
        ...(metadata.ownerId === undefined ? {} : { ownerId: metadata.ownerId }),
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

function samePathList(left: readonly string[], right: readonly string[]): boolean {
  const sort = (paths: readonly string[]): string[] => [...paths].sort();
  const a = sort(left);
  const b = sort(right);
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

export function runAppServer(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): void {
  const paths = resolveAppPaths(resolveDefaultAppDataRoot());
  const sandboxRunner = resolveSandboxRunner();
  const controller = new AppServerController({
    databasePath: path.join(paths.state, "tasks.sqlite"),
    attachments: new AttachmentStore(paths.attachments),
    engine: new PiAppServerEngine(
      new PiAgentEngine(paths.sessions, async () => {
        const lease = resolveCredential("deepseek");
        return lease ? { secret: lease.value, release: lease.release } : undefined;
      }),
      new PiAgentEngine(
        paths.sessions,
        async () => {
          const lease = resolveCredential("minimax-cn");
          return lease ? { secret: lease.value, release: lease.release } : undefined;
        },
        "minimax-cn",
      ),
    ),
    ownerId: `app-server:${process.pid}`,
    activeSecrets: resolveActiveProviderSecrets,
    ...(sandboxRunner === undefined
      ? {}
      : {
          validatorRunner: {
            run: (command, workspace, signal) =>
              new MacSandboxValidator(new MacSandboxRunner(sandboxRunner), workspace, command).run(
                signal,
              ),
          },
        }),
  });
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  const write = (message: ProtocolMessage): void => {
    stdout.write(encodeJsonLine(message));
  };
  void (async () => {
    try {
      for await (const line of lines) {
        try {
          const responses = await controller.dispatch(decodeJsonLine(line), write);
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

function resolveSandboxRunner(): string | undefined {
  const candidates = [
    process.env.CANDY_SANDBOX_RUNNER,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../native/candy-sandbox-runner"),
    path.resolve(process.cwd(), "native/sandbox-runner/target/debug/candy-sandbox-runner"),
    path.resolve(process.cwd(), "../../native/sandbox-runner/target/debug/candy-sandbox-runner"),
  ];
  return candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined && path.isAbsolute(candidate) && existsSync(candidate),
  );
}

function mapPiObservation(observation: PiAgentObservation): AgentObservation {
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
  return { type: "turn.completed", taskId: observation.taskId, at: Date.now() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAppServer(process.stdin, process.stdout);
}
