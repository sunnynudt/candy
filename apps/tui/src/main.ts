import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type FileDeleteApprovalRequest,
  PI_COMPATIBILITY_VERSION,
  PiAgentEngine,
  type PiAgentEngineInput,
  type PiAgentObservation,
  listPiPublicExports,
} from "@candy/pi-adapter";
import {
  DEFAULT_CANDY_MODEL,
  NativeProcessRunner,
  resolveAppPaths,
  resolveCredential,
  resolveDefaultAppDataRoot,
  resolveNativeProcessRunnerPath,
  SQLiteTaskStore,
  SystemClock,
  type TaskMetadata,
} from "@candy/platform";
import {
  CommandValidator,
  CandyRuntime,
  DeterministicAgentEngine,
  GitWorkspaceChangeTracker,
  NonGitWorkspaceChangeTracker,
  ResolvedWorkspaceChangeTracker,
  TaskController,
  TaskScheduler,
  UnavailableBrowserCapability,
  type CommandValidatorCommand,
  type ValidatorResult,
  type WorkspaceChangeSnapshot,
  type WorkspaceChangeTracker,
} from "@candy/runtime";
import { CandyTuiSurface, type CandyTuiTerminal } from "./pi-tui-surface.js";

export interface TuiSmokeResult {
  readonly piVersion: string;
  readonly piRootExportCount: number;
  readonly browserAvailable: boolean;
  readonly observationTypes: readonly string[];
}

export interface TuiTaskSmokeResult {
  readonly taskId: string;
  readonly state: string;
  readonly revision: number;
  readonly queued: readonly string[];
  readonly observations: readonly string[];
}

export async function runTuiSmoke(): Promise<TuiSmokeResult> {
  const browser = new UnavailableBrowserCapability();
  const runtime = new CandyRuntime(
    new DeterministicAgentEngine(new SystemClock(), "fixture response"),
    browser,
  );
  const observations = await runtime.runReadOnlyTurn(
    { taskId: "smoke-task", prompt: "inspect the fixture" },
    new AbortController().signal,
  );

  return {
    piVersion: PI_COMPATIBILITY_VERSION,
    piRootExportCount: listPiPublicExports().length,
    browserAvailable: browser.available,
    observationTypes: observations.map((observation) => observation.type),
  };
}

export async function runTuiTaskSmoke(): Promise<TuiTaskSmokeResult> {
  const task = new TaskController("tui-task-smoke", "read-only");
  const scheduler = new TaskScheduler();
  scheduler.enqueue("tui-task-smoke");
  scheduler.startAvailable();
  task.setOwner("tui-smoke-owner", 0);
  const runtime = new CandyRuntime(
    new DeterministicAgentEngine(new SystemClock(), "read-only response"),
    new UnavailableBrowserCapability(),
  );
  const observations = await runtime.runReadOnlyTurn(
    { taskId: "tui-task-smoke", prompt: "inspect the fixture" },
    new AbortController().signal,
  );
  const completed = task.transition("completed", 1);
  scheduler.finish("tui-task-smoke");
  return {
    taskId: completed.taskId,
    state: completed.state,
    revision: completed.revision,
    queued: scheduler.queued(),
    observations: observations.map((observation) => observation.type),
  };
}

export interface InteractiveTuiOptions {
  readonly appDataRoot?: string;
  readonly workspacePath?: string;
  readonly engine?: TuiAgentEngine;
  readonly terminal?: CandyTuiTerminal;
  readonly changeTracker?: WorkspaceChangeTracker;
  readonly validator?: TuiValidator;
  readonly validatorCommand?: CommandValidatorCommand;
  readonly validatorTimeoutMs?: number;
  readonly activeSecrets?: () => readonly string[];
}

export interface TuiAgentEngine {
  runTurn(input: PiAgentEngineInput, signal: AbortSignal): AsyncIterable<PiAgentObservation>;
  recoverPrompt?(taskId: string, cwd: string): Promise<string | undefined>;
}

export interface TuiValidator {
  run(
    command: CommandValidatorCommand,
    workspace: string,
    signal: AbortSignal,
    activeSecrets: readonly string[],
  ): Promise<ValidatorResult>;
}

type TuiValidatorStatus =
  "configured" | "running" | "pass" | "fail" | "cancelled" | "timeout" | "blocked";

interface TuiValidatorState {
  readonly status: Exclude<TuiValidatorStatus, "configured">;
  readonly evidence?: string;
  readonly durationMs?: number;
}

const MAX_TUI_DIFF_BYTES = 64 * 1024;
const DEFAULT_VALIDATOR_TIMEOUT_MS = 30_000;

export class InteractiveTui {
  readonly #appDataRoot: string;
  readonly #workspacePath: string;
  readonly #terminal: CandyTuiTerminal | undefined;
  readonly #store: SQLiteTaskStore;
  readonly #scheduler: TaskScheduler;
  readonly #changeTracker: WorkspaceChangeTracker;
  readonly #validator: TuiValidator | undefined;
  readonly #validatorTimeoutMs: number;
  readonly #activeSecretsProvider: (() => readonly string[]) | undefined;
  readonly #controllers = new Map<string, TaskController>();
  readonly #prompts = new Map<string, string>();
  readonly #abortControllers = new Map<string, AbortController>();
  readonly #validatorAbortControllers = new Map<string, AbortController>();
  readonly #validatorStops = new Map<string, "cancelled" | "timeout">();
  readonly #validatorStates = new Map<string, TuiValidatorState>();
  readonly #requestedStops = new Map<string, "paused" | "cancelled">();
  readonly #deleteApprovals = new Map<
    string,
    { readonly taskId: string; readonly settle: (approved: boolean) => void }
  >();
  readonly #engine: TuiAgentEngine;
  readonly #ownerId = `tui:${process.pid}`;
  #currentTaskId: string | undefined;
  #surface: CandyTuiSurface | undefined = undefined;
  #resolveExit: (() => void) | undefined = undefined;
  #closing = false;
  #approvalProfile: "read-only" | "auto" = "read-only";
  #validatorCommand: CommandValidatorCommand | undefined;

  public constructor(options: InteractiveTuiOptions = {}) {
    this.#appDataRoot = options.appDataRoot ?? resolveDefaultAppDataRoot();
    this.#workspacePath = path.resolve(options.workspacePath ?? process.cwd());
    this.#terminal = options.terminal;
    const paths = resolveAppPaths(this.#appDataRoot);
    this.#store = new SQLiteTaskStore(path.join(paths.state, "tasks.sqlite"));
    this.#changeTracker =
      options.changeTracker ??
      new ResolvedWorkspaceChangeTracker(
        new GitWorkspaceChangeTracker(),
        new NonGitWorkspaceChangeTracker(),
      );
    this.#validator = options.validator ?? createNativeTuiValidator();
    this.#validatorTimeoutMs = options.validatorTimeoutMs ?? DEFAULT_VALIDATOR_TIMEOUT_MS;
    this.#activeSecretsProvider = options.activeSecrets;
    this.#validatorCommand = options.validatorCommand;
    this.#store.markOwnerInterrupted(this.#ownerId);
    for (const metadata of this.#store.list()) {
      this.#controllers.set(
        metadata.taskId,
        new TaskController(metadata.taskId, metadata.approvalProfile, this.#store),
      );
    }
    this.#scheduler = new TaskScheduler(3, 5, this.#store);
    this.#engine =
      options.engine ??
      new PiAgentEngine(paths.sessions, async () => {
        const lease = resolveCredential("deepseek");
        return lease ? { secret: lease.value, release: lease.release } : undefined;
      });
  }

  public async run(): Promise<void> {
    this.#surface = new CandyTuiSurface({
      appDataRoot: this.#appDataRoot,
      terminal: this.#terminal,
      onSubmit: (text: string): void => {
        try {
          this.handleInput(text);
        } catch (error) {
          this.write(`input rejected: ${safeError(error)}\n`);
        }
      },
      onInterrupt: (): void => this.requestExit(),
    });
    this.write("Candy TUI — local-first, one agent per task\n");
    this.write(
      "Enter a prompt, :new [prompt], :use <task-id>, :profile read-only|auto, :validator <absolute-executable> [args], :changes, :diff [path], :validate, :tasks, :prioritize <task-id>, :pause <task-id>, :resume <task-id>, :cancel <task-id>, or :quit.\n",
    );
    this.write("Profile: read-only. Auto enables file create/edit/delete; Shell stays disabled.\n");
    const exitPromise: Promise<void> = new Promise<void>((resolve: () => void): void => {
      this.#resolveExit = resolve;
    });
    try {
      this.#surface.start();
      await exitPromise;
    } finally {
      this.#closing = true;
      for (const task of this.#controllers.values()) {
        const current = task.snapshot();
        if (current.state === "running" || current.state === "waiting_approval")
          task.transition("interrupted", current.revision);
      }
      this.#store.markOwnerInterrupted(this.#ownerId);
      for (const approval of this.#deleteApprovals.values()) approval.settle(false);
      for (const controller of this.#abortControllers.values()) controller.abort();
      for (const controller of this.#validatorAbortControllers.values()) controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.#resolveExit = undefined;
      await this.#surface.stop();
      this.#surface = undefined;
      this.#store.close();
    }
  }

  private handleInput(value: string): void {
    const trimmed: string = value.trim();
    if (trimmed === ":quit") {
      this.requestExit();
    } else if (trimmed === ":new" || trimmed.startsWith(":new ")) {
      this.newTask(trimmed.slice(4).trim());
    } else if (trimmed.startsWith(":use ")) {
      this.useTask(trimmed.slice(5).trim());
    } else if (trimmed === ":tasks") {
      this.printTasks();
    } else if (trimmed.startsWith(":profile ")) {
      this.setProfile(trimmed.slice(9).trim());
    } else if (trimmed === ":validator" || trimmed.startsWith(":validator ")) {
      this.configureValidator(trimmed.slice(10).trim());
    } else if (trimmed === ":changes") {
      void this.showChanges().catch((error: unknown) => {
        this.write(`changes rejected: ${safeError(error)}\n`);
      });
    } else if (trimmed === ":diff" || trimmed.startsWith(":diff ")) {
      void this.showDiff(trimmed.slice(5).trim()).catch((error: unknown) => {
        this.write(`diff rejected: ${safeError(error)}\n`);
      });
    } else if (trimmed === ":validate") {
      this.validateCurrent();
    } else if (trimmed.startsWith(":approve ")) {
      this.resolveDeleteApproval(trimmed.slice(9).trim(), true);
    } else if (trimmed.startsWith(":deny ")) {
      this.resolveDeleteApproval(trimmed.slice(6).trim(), false);
    } else if (trimmed.startsWith(":prioritize ")) {
      this.prioritize(trimmed.slice(12).trim());
    } else if (trimmed.startsWith(":pause ")) {
      this.pause(trimmed.slice(7).trim());
    } else if (trimmed.startsWith(":resume ")) {
      this.resume(trimmed.slice(8).trim());
    } else if (trimmed.startsWith(":cancel ")) {
      void this.cancel(trimmed.slice(8).trim()).catch((error: unknown) => {
        this.write(`cancel rejected: ${safeError(error)}\n`);
      });
    } else if (trimmed.length > 0) {
      this.submitPrompt(trimmed);
    }
  }

  private requestExit(): void {
    this.#resolveExit?.();
  }

  private create(prompt: string): void {
    void this.createTask(prompt).catch((error: unknown) => {
      this.write(`task creation rejected: ${safeError(error)}\n`);
    });
  }

  private async createTask(prompt: string): Promise<void> {
    if (containsCredentialMaterial(prompt)) {
      this.write("prompt rejected: credential-shaped content is forbidden\n");
      return;
    }
    const taskId = `task-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const queueOrder =
      this.#store.queued().reduce((max, task) => Math.max(max, task.queueOrder ?? 0), 0) + 1;
    const metadata = this.#store.create(
      taskId,
      this.#approvalProfile,
      queueOrder,
      DEFAULT_CANDY_MODEL,
      [],
      this.#workspacePath,
      this.#validatorCommand,
    );
    const controller = new TaskController(taskId, this.#approvalProfile, this.#store);
    this.#controllers.set(taskId, controller);
    this.#prompts.set(taskId, prompt);
    this.#currentTaskId = taskId;
    this.#scheduler.enqueue(taskId);
    this.write(`created ${taskId} (${metadata.state})\n`);
    const workspaceBaseline = await this.#changeTracker.captureBaseline(this.#workspacePath);
    this.#store.updateBaseline(taskId, workspaceBaseline);
    this.drain(new Map([[taskId, prompt]]));
  }

  private drain(explicitPrompts: ReadonlyMap<string, string> = new Map()): void {
    for (const taskId of this.#scheduler.startAvailable()) {
      if (this.#abortControllers.has(taskId)) continue;
      const task = this.ensureController(taskId);
      if (!task || !["queued", "paused", "interrupted"].includes(task.snapshot().state)) continue;
      const running = task.setOwner(this.#ownerId, task.snapshot().revision);
      const abort = new AbortController();
      this.#abortControllers.set(taskId, abort);
      void this.runTask(task, running.revision, abort, explicitPrompts.get(taskId));
    }
  }

  private ensureController(taskId: string): TaskController | undefined {
    const metadata = this.#store.get(taskId);
    if (!metadata) return undefined;
    const existing = this.#controllers.get(taskId);
    if (existing?.snapshot().revision === metadata.revision) return existing;
    const controller = new TaskController(taskId, metadata.approvalProfile, this.#store);
    this.#controllers.set(taskId, controller);
    return controller;
  }

  private submitPrompt(prompt: string): void {
    const currentTaskId = this.#currentTaskId;
    if (currentTaskId === undefined) {
      this.create(prompt);
      return;
    }
    const task = this.ensureController(currentTaskId);
    if (!task) {
      this.write(`current task ${currentTaskId} is unavailable; use :new\n`);
      return;
    }
    const snapshot = task.snapshot();
    if (snapshot.state === "running" || snapshot.state === "waiting_approval") {
      if (snapshot.ownerId !== undefined && snapshot.ownerId !== this.#ownerId) {
        this.write(`task ${currentTaskId} is read-only: owned by ${snapshot.ownerId}\n`);
      } else {
        this.write(`task ${currentTaskId} is already running; wait for the active turn\n`);
      }
      return;
    }
    if (snapshot.state === "queued") {
      this.write(`task ${currentTaskId} is queued; cannot add a prompt to its active turn\n`);
      return;
    }
    if (snapshot.state === "cancelled") {
      this.write(`task ${currentTaskId} is cancelled; use :new to create another task\n`);
      return;
    }
    task.queueForContinuation(snapshot.revision);
    this.#prompts.set(currentTaskId, prompt);
    this.#scheduler.enqueue(currentTaskId);
    this.write(`continuing ${currentTaskId}\n`);
    this.drain(new Map([[currentTaskId, prompt]]));
  }

  private newTask(prompt: string): void {
    this.#currentTaskId = undefined;
    if (prompt.length === 0) {
      this.write("new task ready; enter a prompt\n");
      return;
    }
    this.create(prompt);
  }

  private configureValidator(value: string): void {
    if (value === "") {
      this.write(
        this.#validatorCommand === undefined
          ? "validator not configured; use :validator <absolute-executable> [args]\n"
          : `validator configured: ${this.#validatorCommand.executable} ${this.#validatorCommand.args.join(" ")}\n`,
      );
      return;
    }
    if (value === "off") {
      this.#validatorCommand = undefined;
      this.write("validator cleared for new tasks\n");
      return;
    }
    const parts = value.split(/\s+/u).filter((part) => part.length > 0);
    const executable = parts.shift();
    if (
      executable === undefined ||
      !isAbsoluteCommandPath(executable) ||
      parts.some((part) => containsControlCharacter(part)) ||
      containsCredentialMaterial(value)
    ) {
      this.write("validator rejected: use an absolute executable and safe direct arguments\n");
      return;
    }
    this.#validatorCommand = { executable, args: parts };
    this.write(`validator configured for new tasks: ${executable}\n`);
  }

  private async showChanges(): Promise<void> {
    const task = this.currentTask();
    if (task === undefined) {
      this.write("no current task; use :use <task-id> or create a task first\n");
      return;
    }
    const snapshot = this.#store.get(task.snapshot().taskId);
    if (snapshot === undefined) {
      this.write("current task metadata is unavailable\n");
      return;
    }
    const changes = await this.inspectWorkspaceChanges(snapshot);
    if (!changes.available) {
      this.write(`changed files: unavailable for ${snapshot.taskId}\n`);
      return;
    }
    const removed = extractRemovedPaths(changes.patchText);
    this.write(
      [
        `changed files: ${snapshot.taskId}`,
        `tracked: ${formatPaths(changes.tracked)}`,
        `untracked: ${formatPaths(changes.untracked)}`,
        `removed: ${formatPaths(removed)}`,
        ...(changes.patchTruncated ? ["diff: tracker output truncated"] : []),
        "",
      ].join("\n"),
    );
  }

  private async showDiff(requestedPath: string): Promise<void> {
    if (requestedPath !== "") assertSafeDiffPath(requestedPath);
    const task = this.currentTask();
    if (task === undefined) {
      this.write("no current task; use :use <task-id> or create a task first\n");
      return;
    }
    const snapshot = this.#store.get(task.snapshot().taskId);
    if (snapshot === undefined) {
      this.write("current task metadata is unavailable\n");
      return;
    }
    const changes = await this.inspectWorkspaceChanges(snapshot);
    if (!changes.available) {
      this.write(`diff unavailable for ${snapshot.taskId}\n`);
      return;
    }
    const selected = selectDiff(changes.patchText, requestedPath);
    const bounded = truncateTuiDiff(selected);
    this.write(
      `diff ${snapshot.taskId}${requestedPath === "" ? "" : ` ${requestedPath}`}\n${bounded || "(no diff)\n"}`,
    );
    if (changes.patchTruncated) this.write("[diff truncated by workspace tracker]\n");
  }

  private currentTask(): TaskController | undefined {
    return this.#currentTaskId === undefined
      ? undefined
      : this.ensureController(this.#currentTaskId);
  }

  private async inspectWorkspaceChanges(snapshot: TaskMetadata): Promise<WorkspaceChangeSnapshot> {
    return this.withActiveSecrets((activeSecrets) =>
      this.#changeTracker.inspect(
        snapshot.workspacePath,
        snapshot.workspaceBaseline,
        activeSecrets,
      ),
    );
  }

  private validateCurrent(): void {
    const task = this.currentTask();
    if (task === undefined) {
      this.write("no current task; use :use <task-id> or create a task first\n");
      return;
    }
    const snapshot = task.snapshot();
    if (snapshot.state === "running" || snapshot.state === "waiting_approval") {
      this.write(`task ${snapshot.taskId} is already running; validator is not started\n`);
      return;
    }
    const metadata = this.#store.get(snapshot.taskId);
    if (metadata?.validator === undefined) {
      this.write("validator not configured for this task; configure it before :new\n");
      return;
    }
    if (this.#validator === undefined) {
      this.#validatorStates.set(snapshot.taskId, {
        status: "blocked",
        evidence: "native runner unavailable",
      });
      this.write("validator blocked: native Sandbox Runner is unavailable on this installation\n");
      return;
    }
    if (this.#validatorAbortControllers.has(snapshot.taskId)) {
      this.write(`validator running: ${snapshot.taskId}\n`);
      return;
    }
    const abort = new AbortController();
    this.#validatorAbortControllers.set(snapshot.taskId, abort);
    this.#validatorStates.set(snapshot.taskId, { status: "running" });
    this.write(`validator running: ${snapshot.taskId}\n`);
    void this.runValidator(metadata, abort).catch((error: unknown) => {
      this.write(`validator failed: ${safeError(error)}\n`);
    });
  }

  private async runValidator(snapshot: TaskMetadata, abort: AbortController): Promise<void> {
    const timeoutHandle = setTimeout(() => {
      this.#validatorStops.set(snapshot.taskId, "timeout");
      abort.abort(new Error("validator timeout"));
    }, this.#validatorTimeoutMs);
    timeoutHandle.unref?.();
    try {
      const outcome = await this.withActiveSecrets(async (activeSecrets) => ({
        activeSecrets,
        result: await this.#validator!.run(
          snapshot.validator!,
          snapshot.workspacePath,
          abort.signal,
          activeSecrets,
        ),
      }));
      const requestedStop = this.#validatorStops.get(snapshot.taskId);
      const status: Exclude<TuiValidatorStatus, "configured" | "running" | "blocked"> =
        requestedStop === "timeout"
          ? "timeout"
          : requestedStop === "cancelled" || abort.signal.aborted
            ? "cancelled"
            : outcome.result.ok
              ? "pass"
              : "fail";
      this.finishValidator(
        snapshot.taskId,
        status,
        redactSensitive(outcome.result.evidence, outcome.activeSecrets),
        outcome.result.durationMs,
      );
    } catch (error) {
      const requestedStop = this.#validatorStops.get(snapshot.taskId);
      const status: Exclude<TuiValidatorStatus, "configured" | "running" | "blocked"> =
        requestedStop === "timeout"
          ? "timeout"
          : requestedStop === "cancelled" || abort.signal.aborted
            ? "cancelled"
            : "fail";
      this.finishValidator(
        snapshot.taskId,
        status,
        status === "timeout"
          ? "validator timeout"
          : status === "cancelled"
            ? "validator cancelled"
            : safeError(error),
      );
    } finally {
      clearTimeout(timeoutHandle);
      this.#validatorAbortControllers.delete(snapshot.taskId);
      this.#validatorStops.delete(snapshot.taskId);
    }
  }

  private finishValidator(
    taskId: string,
    status: Exclude<TuiValidatorStatus, "configured" | "running" | "blocked">,
    evidence: string,
    durationMs?: number,
  ): void {
    const boundedEvidence = evidence.slice(0, 4_096);
    this.#validatorStates.set(taskId, {
      status,
      evidence: boundedEvidence,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
    this.#store.recordRun({
      taskId,
      rounds: 1,
      evidenceCount: 1,
      completed: status === "pass",
      stopReason:
        status === "pass" ? "validator_succeeded" : status === "cancelled" ? "cancelled" : "error",
      evidenceSummary: boundedEvidence,
    });
    this.#store.appendTranscript(taskId, [
      { role: "tool", text: transcriptText(`validator ${status}: ${boundedEvidence}`) },
    ]);
    this.write(`validator ${status}: ${boundedEvidence}\n`);
  }

  private async withActiveSecrets<T>(
    callback: (activeSecrets: readonly string[]) => Promise<T>,
  ): Promise<T> {
    if (this.#activeSecretsProvider !== undefined) return callback(this.#activeSecretsProvider());
    let lease: ReturnType<typeof resolveCredential>;
    try {
      lease = resolveCredential("deepseek");
    } catch {
      lease = undefined;
    }
    try {
      return await callback(lease === undefined ? [] : [lease.value]);
    } finally {
      lease?.release();
    }
  }

  private useTask(taskId: string): void {
    const task = this.ensureController(taskId);
    if (!task) {
      this.write(`task ${taskId} does not exist\n`);
      return;
    }
    this.#currentTaskId = taskId;
    const snapshot = task.snapshot();
    if (
      snapshot.state === "running" &&
      snapshot.ownerId !== undefined &&
      snapshot.ownerId !== this.#ownerId
    ) {
      this.write(
        `current task: ${taskId} (read-only task: ${taskId}; owned by ${snapshot.ownerId})\n`,
      );
      return;
    }
    this.write(`current task: ${taskId} (${snapshot.state})\n`);
  }

  private async runTask(
    task: TaskController,
    revision: number,
    abort: AbortController,
    explicitPrompt?: string,
  ): Promise<void> {
    const taskId = task.snapshot().taskId;
    try {
      const taskSnapshot = this.#store.get(taskId);
      if (taskSnapshot === undefined) throw new Error("Task metadata is unavailable after start.");
      const prompt =
        explicitPrompt ??
        this.#prompts.get(taskId) ??
        (await this.#engine.recoverPrompt?.(taskId, taskSnapshot.workspacePath));
      if (prompt === undefined) throw new Error("Task prompt is unavailable after restart.");
      if (explicitPrompt !== undefined) {
        this.#prompts.set(taskId, explicitPrompt);
        this.#store.appendTranscript(taskId, [
          { role: "user", text: transcriptText(explicitPrompt) },
        ]);
      }
      for await (const observation of this.#engine.runTurn(
        {
          taskId,
          prompt,
          model: taskSnapshot.model,
          cwd: taskSnapshot.workspacePath,
          approvalProfile: taskSnapshot.approvalProfile,
          ...(taskSnapshot.approvalProfile === "auto"
            ? {
                fileDeleteApproval: (request: FileDeleteApprovalRequest, signal: AbortSignal) =>
                  this.requestFileDeleteApproval(taskId, request, signal),
              }
            : {}),
        },
        abort.signal,
      )) {
        if (observation.type === "assistant.delta") {
          this.write(observation.text);
          this.#store.appendTranscript(taskId, [
            { role: "assistant", text: transcriptText(observation.text) },
          ]);
        }
        if (observation.type === "tool.completed") {
          this.write(`\n[tool ${observation.tool}]\n`);
          this.#store.appendTranscript(taskId, [
            {
              role: "tool",
              text: transcriptText(`${observation.tool}:${observation.ok ? "ok" : "error"}`),
            },
          ]);
        }
      }
      const current = task.snapshot();
      if (current.state === "running" && current.revision === revision) {
        const completed = task.transition("completed", revision);
        this.write(`\n${completed.taskId} completed\n`);
      }
    } catch (error) {
      const current = task.snapshot();
      if (current.state === "running") {
        const requestedStop = this.#requestedStops.get(taskId);
        const stopped = task.transition(
          requestedStop ?? (abort.signal.aborted ? "cancelled" : "interrupted"),
          current.revision,
        );
        this.write(`\n${stopped.taskId} ${stopped.state}: ${safeError(error)}\n`);
      }
    } finally {
      this.#abortControllers.delete(taskId);
      this.#requestedStops.delete(taskId);
      this.#scheduler.finish(taskId);
      if (!this.#closing) this.drain();
    }
  }

  private async cancel(taskId: string): Promise<void> {
    const validatorAbort = this.#validatorAbortControllers.get(taskId);
    if (validatorAbort !== undefined) {
      this.#validatorStops.set(taskId, "cancelled");
      validatorAbort.abort(new Error("validator cancelled"));
      return;
    }
    const abort = this.#abortControllers.get(taskId);
    if (abort) {
      this.#requestedStops.set(taskId, "cancelled");
      abort.abort();
      return;
    }
    const task = this.#controllers.get(taskId);
    if (task?.snapshot().state === "queued") {
      this.#scheduler.cancelQueued(taskId);
      task.transition("cancelled", task.snapshot().revision);
      this.write(`${taskId} cancelled before start\n`);
    } else {
      this.write(`${taskId} is not an active task\n`);
    }
  }

  private pause(taskId: string): void {
    const abort = this.#abortControllers.get(taskId);
    if (abort) {
      this.#requestedStops.set(taskId, "paused");
      abort.abort();
      return;
    }
    const task = this.#controllers.get(taskId);
    if (task?.snapshot().state === "queued") {
      this.#scheduler.cancelQueued(taskId);
      task.transition("paused", task.snapshot().revision);
      this.write(`${taskId} paused before start\n`);
    } else {
      this.write(`${taskId} is not pausable\n`);
    }
  }

  private prioritize(taskId: string): void {
    const next = this.#scheduler.queued().find((candidate) => candidate !== taskId);
    if (next === undefined) {
      this.write(`${taskId} is already next or is not queued\n`);
      return;
    }
    if (this.#scheduler.moveQueuedBefore(taskId, next)) {
      this.write(`${taskId} moved to the front of the queue\n`);
    } else {
      this.write(`${taskId} is not queued\n`);
    }
  }

  private resume(taskId: string): void {
    const task = this.#controllers.get(taskId);
    if (task?.snapshot().state === "paused" || task?.snapshot().state === "interrupted") {
      this.#scheduler.enqueue(taskId);
      this.write(`${taskId} queued for resume\n`);
      this.drain();
    } else {
      this.write(`${taskId} is not resumable\n`);
    }
  }

  private printTasks(): void {
    for (const task of this.#store.list()) {
      const current = task.taskId === this.#currentTaskId ? "*" : " ";
      const validator = this.validatorStatus(task);
      this.write(
        `${current}${task.taskId}\t${task.state}\t${task.model}\t${task.workspacePath}\tr${task.revision}\tq${task.queueOrder ?? "-"}\tvalidator=${validator}\n`,
      );
    }
  }

  private validatorStatus(task: TaskMetadata): string {
    const state = this.#validatorStates.get(task.taskId);
    if (state !== undefined) return state.status;
    if (task.validator === undefined) return "not-configured";
    const run = this.#store.getRun(task.taskId);
    if (run?.stopReason === "validator_succeeded") return "pass";
    if (run?.stopReason === "cancelled") return "cancelled";
    if (run?.stopReason === "error") return "fail";
    return "configured";
  }

  private setProfile(value: string): void {
    if (value !== "read-only" && value !== "auto") {
      this.write("profile must be read-only or auto\n");
      return;
    }
    this.#approvalProfile = value;
    this.write(
      value === "auto"
        ? "profile auto: file read/create/edit enabled; delete requires confirmation; Shell disabled\n"
        : "profile read-only: file mutation disabled\n",
    );
  }

  private requestFileDeleteApproval(
    taskId: string,
    request: FileDeleteApprovalRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const approvalId = `delete-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", denyOnAbort);
        this.#deleteApprovals.delete(approvalId);
        resolve(approved);
      };
      const denyOnAbort = (): void => settle(false);
      this.#deleteApprovals.set(approvalId, { taskId, settle });
      signal.addEventListener("abort", denyOnAbort, { once: true });
      this.write(
        `\napproval required: delete ${request.path}\n:approve ${approvalId} or :deny ${approvalId}\n`,
      );
    });
  }

  private resolveDeleteApproval(approvalId: string, approved: boolean): void {
    const approval = this.#deleteApprovals.get(approvalId);
    if (approval === undefined) {
      this.write(`${approvalId} is not awaiting deletion approval\n`);
      return;
    }
    approval.settle(approved);
    this.write(`${approval.taskId} deletion ${approved ? "approved" : "denied"}\n`);
  }

  private write(value: string): void {
    this.#surface?.appendTranscript(redactTuiOutput(value));
  }
}

function createNativeTuiValidator(): TuiValidator | undefined {
  const runnerPath = resolveNativeProcessRunnerPath(import.meta.url);
  if (runnerPath === undefined) return undefined;
  const commandValidator = new CommandValidator(new NativeProcessRunner(runnerPath));
  return {
    run: (command, workspace, signal, activeSecrets) =>
      commandValidator.run(command, workspace, signal, {}, activeSecrets),
  };
}

function formatPaths(paths: readonly string[]): string {
  return paths.length === 0 ? "(none)" : paths.join(", ");
}

function extractRemovedPaths(patchText: string): readonly string[] {
  const removed: string[] = [];
  for (const section of patchText.split(/(?=^diff --git )/gmu)) {
    if (!section.startsWith("diff --git ") || !/^deleted file mode /mu.test(section)) continue;
    const header = section.split(/\r?\n/u, 1)[0] ?? "";
    const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/u);
    const value = match?.[2] ?? match?.[1];
    if (value !== undefined) removed.push(value);
  }
  return [...new Set(removed)].sort();
}

function selectDiff(patchText: string, requestedPath: string): string {
  if (requestedPath === "") return patchText;
  if (!patchText.includes("diff --git ")) {
    return patchText
      .split(/\r?\n/u)
      .filter((line) => line.includes(requestedPath))
      .join("\n");
  }
  return patchText
    .split(/(?=^diff --git )/gmu)
    .filter((section) => {
      const header = section.split(/\r?\n/u, 1)[0] ?? "";
      return header.includes(`a/${requestedPath}`) || header.includes(`b/${requestedPath}`);
    })
    .join("");
}

function truncateTuiDiff(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_TUI_DIFF_BYTES) return value;
  const notice = `\n[diff truncated at ${MAX_TUI_DIFF_BYTES} bytes]\n`;
  const contentLimit = MAX_TUI_DIFF_BYTES - Buffer.byteLength(notice, "utf8");
  return `${Buffer.from(value, "utf8").subarray(0, contentLimit).toString("utf8")}${notice}`;
}

function assertSafeDiffPath(value: string): void {
  if (
    containsControlCharacter(value) ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.split(/[\\/]+/u).some((segment) => segment === "..")
  ) {
    throw new Error("Diff paths must be safe workspace-relative paths.");
  }
}

function isAbsoluteCommandPath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function redactSensitive(value: string, activeSecrets: readonly string[]): string {
  return activeSecrets.reduce(
    (result, secret) => (secret.length === 0 ? result : result.split(secret).join("[REDACTED]")),
    redactTuiOutput(value),
  );
}

function safeError(error: unknown): string {
  if (error instanceof Error && /credentials|cancelled|unavailable/iu.test(error.message))
    return error.message;
  return "runtime error";
}

function containsCredentialMaterial(value: string): boolean {
  return /(?:Bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,})/u.test(
    value,
  );
}

function redactTuiOutput(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/giu, `$1[REDACTED]`)
    .replace(/\b(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,}\b/gu, "[REDACTED]");
}

function transcriptText(value: string): string {
  return redactTuiOutput(value).slice(0, 4_096);
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href
  );
}

if (isDirectExecution()) {
  if (process.argv.includes("--smoke-task")) console.log(JSON.stringify(await runTuiTaskSmoke()));
  else if (process.argv.includes("--smoke")) console.log(JSON.stringify(await runTuiSmoke()));
  else await new InteractiveTui().run();
}
