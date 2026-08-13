import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CANDY_MODEL, type CandyModelId, type Clock } from "@candy/platform";

export interface AgentTurnInput {
  readonly taskId: string;
  readonly prompt: string;
  readonly model?: CandyModelId;
  /** Selected Local Workspace used by the task's tools and session. */
  readonly cwd?: string;
  readonly approvalProfile?: "read-only" | "auto";
  readonly images?: readonly AgentImageInput[];
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly trustedShell?: boolean;
  readonly shellApproval?: (
    request: { readonly command: string; readonly cwd: string; readonly timeout?: number },
    signal: AbortSignal,
  ) => Promise<boolean>;
}

export interface AgentImageInput {
  readonly mimeType: string;
  readonly data: string;
}

export type AgentObservation =
  | { readonly type: "turn.started"; readonly taskId: string; readonly at: number }
  | { readonly type: "assistant.thinking.delta"; readonly text: string }
  | { readonly type: "assistant.delta"; readonly text: string }
  | { readonly type: "tool.started"; readonly taskId: string; readonly tool: string }
  | {
      readonly type: "tool.completed";
      readonly taskId: string;
      readonly tool: string;
      readonly ok: boolean;
    }
  | { readonly type: "turn.completed"; readonly taskId: string; readonly at: number };

export interface AgentEngine {
  runTurn(input: AgentTurnInput, signal: AbortSignal): AsyncIterable<AgentObservation>;
}

/** Optional recovery seam for engines whose session store owns the prompt. */
export interface RecoverableAgentEngine extends AgentEngine {
  recoverPrompt?(taskId: string, cwd: string): Promise<string | undefined>;
}

export class DeterministicAgentEngine implements AgentEngine {
  public constructor(
    private readonly clock: Clock,
    private readonly response: string,
  ) {}

  public async *runTurn(
    input: AgentTurnInput,
    signal: AbortSignal,
  ): AsyncIterable<AgentObservation> {
    throwIfAborted(signal);
    yield { type: "turn.started", taskId: input.taskId, at: this.clock.now() };
    throwIfAborted(signal);
    yield { type: "assistant.delta", text: this.response };
    throwIfAborted(signal);
    yield { type: "turn.completed", taskId: input.taskId, at: this.clock.now() };
  }
}

export interface BrowserCapability {
  readonly available: boolean;
  open(taskId: string, url: string, signal: AbortSignal): Promise<void>;
}

export class BrowserUnavailableError extends Error {
  public constructor() {
    super("Browser capability is unavailable in the TUI runtime.");
    this.name = "BrowserUnavailableError";
  }
}

export class UnavailableBrowserCapability implements BrowserCapability {
  public readonly available = false;

  public open(taskId: string, url: string, signal: AbortSignal): Promise<void> {
    void taskId;
    void url;
    void signal;
    return Promise.reject(new BrowserUnavailableError());
  }
}

export class CandyRuntime {
  public constructor(
    private readonly agentEngine: AgentEngine,
    public readonly browser: BrowserCapability,
  ) {}

  public async runReadOnlyTurn(
    input: AgentTurnInput,
    signal: AbortSignal,
  ): Promise<readonly AgentObservation[]> {
    const observations: AgentObservation[] = [];
    for await (const observation of this.agentEngine.runTurn(input, signal)) {
      observations.push(observation);
    }
    return observations;
  }
}

export class WorkspacePathError extends Error {
  public constructor(message = "Requested path is outside the active workspace.") {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export interface ReadOnlyToolResult {
  readonly ok: boolean;
  readonly path: string;
  readonly content?: string;
  readonly bytes: number;
  readonly error?: "cancelled" | "not_found" | "outside_workspace" | "read_failed";
}

/** Read-only tool host used by the Runtime proof. No shell or mutation exists here. */
export class ReadOnlyWorkspaceTool {
  public constructor(private readonly workspaceRoot: string) {}

  public async read(requestedPath: string, signal: AbortSignal): Promise<ReadOnlyToolResult> {
    throwIfAborted(signal);
    try {
      const absolutePath = this.containedPath(requestedPath);
      const bytes = await readFile(absolutePath);
      throwIfAborted(signal);
      return {
        ok: true,
        path: path.relative(this.workspaceRoot, absolutePath) || ".",
        content: bytes.toString("utf8"),
        bytes: bytes.byteLength,
      };
    } catch (error) {
      if (signal.aborted) return { ok: false, path: requestedPath, bytes: 0, error: "cancelled" };
      if (error instanceof WorkspacePathError) {
        return { ok: false, path: requestedPath, bytes: 0, error: "outside_workspace" };
      }
      if (isNodeError(error) && error.code === "ENOENT") {
        return { ok: false, path: requestedPath, bytes: 0, error: "not_found" };
      }
      return { ok: false, path: requestedPath, bytes: 0, error: "read_failed" };
    }
  }

  public containedPath(requestedPath: string): string {
    const root = path.resolve(this.workspaceRoot);
    const candidate = path.resolve(root, requestedPath);
    const relative = path.relative(root, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new WorkspacePathError();
    }
    return candidate;
  }
}

export interface SessionRecord {
  readonly taskId: string;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly entries: readonly { readonly type: "user" | "assistant"; readonly text: string }[];
}

export interface SessionStore {
  create(taskId: string, sessionId: string, at: number): Promise<void>;
  append(
    taskId: string,
    entry: { readonly type: "user" | "assistant"; readonly text: string },
  ): Promise<void>;
  load(taskId: string): Promise<SessionRecord>;
}

/** JSON session seam for deterministic tests; Pi owns the production JSONL session format. */
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();

  public constructor(private readonly clock: Clock) {}

  public async create(taskId: string, sessionId: string, at = this.clock.now()): Promise<void> {
    if (this.#sessions.has(taskId)) throw new Error(`Session already exists for ${taskId}.`);
    this.#sessions.set(taskId, { taskId, sessionId, createdAt: at, entries: [] });
  }

  public async append(
    taskId: string,
    entry: { readonly type: "user" | "assistant"; readonly text: string },
  ): Promise<void> {
    const session = this.#sessions.get(taskId);
    if (!session) throw new Error(`Session ${taskId} does not exist.`);
    assertNoSecret(entry.text);
    this.#sessions.set(taskId, { ...session, entries: [...session.entries, entry] });
  }

  public async load(taskId: string): Promise<SessionRecord> {
    const session = this.#sessions.get(taskId);
    if (!session) throw new Error(`Session ${taskId} does not exist.`);
    return { ...session, entries: [...session.entries] };
  }
}

export type TaskState =
  "queued" | "running" | "waiting_approval" | "paused" | "interrupted" | "completed" | "cancelled";
export type ApprovalProfile = "read-only" | "auto";

export interface RuntimeTaskSnapshot {
  readonly taskId: string;
  readonly revision: number;
  readonly state: TaskState;
  readonly approvalProfile: ApprovalProfile;
  readonly model: CandyModelId;
  readonly ownerId?: string;
}

/** Synchronous persistence seam implemented by Candy's platform-owned task store. */
export interface TaskMetadataStore {
  create(
    taskId: string,
    approvalProfile: ApprovalProfile,
    queueOrder?: number,
    model?: CandyModelId,
  ): RuntimeTaskSnapshot;
  get(taskId: string): RuntimeTaskSnapshot | undefined;
  transition(
    taskId: string,
    expectedRevision: number,
    state: TaskState,
    ownerId?: string,
  ): RuntimeTaskSnapshot;
}

export class TaskStateError extends Error {}

export class TaskController {
  #snapshot: RuntimeTaskSnapshot;

  public constructor(
    taskId: string,
    approvalProfile: ApprovalProfile = "read-only",
    private readonly persistence?: TaskMetadataStore,
  ) {
    this.#snapshot = persistence?.get(taskId) ??
      persistence?.create(taskId, approvalProfile) ?? {
        taskId,
        revision: 0,
        state: "queued",
        approvalProfile,
        model: DEFAULT_CANDY_MODEL,
      };
  }

  public snapshot(): RuntimeTaskSnapshot {
    return { ...this.#snapshot };
  }

  public transition(
    next: Exclude<TaskState, "queued">,
    expectedRevision: number,
  ): RuntimeTaskSnapshot {
    if (expectedRevision !== this.#snapshot.revision)
      throw new TaskStateError("Task revision is stale.");
    if (!allowedTransition(this.#snapshot.state, next)) {
      throw new TaskStateError(`Cannot transition ${this.#snapshot.state} to ${next}.`);
    }
    const ownerId =
      next === "completed" || next === "cancelled" || next === "interrupted"
        ? undefined
        : this.#snapshot.ownerId;
    if (this.persistence) {
      this.#snapshot = this.persistence.transition(
        taskIdOf(this.#snapshot),
        expectedRevision,
        next,
        ownerId,
      );
    } else {
      const nextSnapshot = {
        ...this.#snapshot,
        state: next,
        revision: this.#snapshot.revision + 1,
      };
      if (ownerId === undefined) {
        const withoutOwner = { ...nextSnapshot };
        delete withoutOwner.ownerId;
        this.#snapshot = withoutOwner;
      } else {
        this.#snapshot = { ...nextSnapshot, ownerId };
      }
    }
    return this.snapshot();
  }

  public setOwner(ownerId: string, expectedRevision: number): RuntimeTaskSnapshot {
    if (expectedRevision !== this.#snapshot.revision)
      throw new TaskStateError("Task revision is stale.");
    if (
      this.#snapshot.state !== "queued" &&
      this.#snapshot.state !== "interrupted" &&
      this.#snapshot.state !== "paused"
    ) {
      throw new TaskStateError("Only resumable tasks can acquire an owner.");
    }
    this.#snapshot = this.persistence
      ? this.persistence.transition(taskIdOf(this.#snapshot), expectedRevision, "running", ownerId)
      : {
          ...this.#snapshot,
          ownerId,
          state: "running",
          revision: this.#snapshot.revision + 1,
        };
    return this.snapshot();
  }

  /** Queue a completed or interrupted task for one explicit follow-up turn. */
  public queueForContinuation(expectedRevision: number): RuntimeTaskSnapshot {
    if (expectedRevision !== this.#snapshot.revision)
      throw new TaskStateError("Task revision is stale.");
    if (
      this.#snapshot.state !== "completed" &&
      this.#snapshot.state !== "paused" &&
      this.#snapshot.state !== "interrupted"
    ) {
      throw new TaskStateError(`Cannot continue ${this.#snapshot.state} task.`);
    }
    this.#snapshot = this.persistence
      ? this.persistence.transition(taskIdOf(this.#snapshot), expectedRevision, "queued")
      : (() => {
          const nextSnapshot = {
            ...this.#snapshot,
            state: "queued" as const,
            revision: expectedRevision + 1,
          };
          const withoutOwner = { ...nextSnapshot };
          delete withoutOwner.ownerId;
          return withoutOwner;
        })();
    return this.snapshot();
  }
}

function taskIdOf(snapshot: RuntimeTaskSnapshot): string {
  return snapshot.taskId;
}

function allowedTransition(current: TaskState, next: TaskState): boolean {
  if (next === "interrupted") return current === "running" || current === "waiting_approval";
  if (next === "cancelled") return current !== "completed" && current !== "cancelled";
  if (next === "paused") return current === "running" || current === "waiting_approval";
  if (next === "waiting_approval") return current === "running";
  if (next === "completed") return current === "running";
  return current === "running" && next === "running";
}

export class TaskScheduler {
  readonly #queue: string[] = [];
  readonly #active = new Set<string>();
  readonly #queueStore: TaskQueueStore | undefined;

  public constructor(
    public readonly defaultLimit = 3,
    public readonly hardLimit = 5,
    queueStore?: TaskQueueStore,
  ) {
    if (!Number.isInteger(defaultLimit) || defaultLimit < 1 || defaultLimit > hardLimit) {
      throw new Error("Invalid scheduler default limit.");
    }
    this.#queueStore = queueStore;
    if (queueStore) this.#queue.push(...queueStore.queued().map((task) => task.taskId));
  }

  public enqueue(taskId: string): void {
    if (!this.#active.has(taskId) && !this.#queue.includes(taskId)) this.#queue.push(taskId);
  }

  public startAvailable(limit = this.defaultLimit): readonly string[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.hardLimit)
      throw new Error("Concurrency limit must be between 1 and 5.");
    while (this.#active.size < limit && this.#queue.length > 0)
      this.#active.add(this.#queue.shift()!);
    return [...this.#active];
  }

  public finish(taskId: string): void {
    this.#active.delete(taskId);
  }

  public cancelQueued(taskId: string): boolean {
    const index = this.#queue.indexOf(taskId);
    if (index < 0) return false;
    this.#queue.splice(index, 1);
    return true;
  }

  /** Moves one not-yet-started task before another queued task. */
  public moveQueuedBefore(taskId: string, beforeTaskId: string): boolean {
    if (taskId === beforeTaskId) return false;
    const sourceIndex = this.#queue.indexOf(taskId);
    const targetIndex = this.#queue.indexOf(beforeTaskId);
    if (sourceIndex < 0 || targetIndex < 0) return false;
    const reordered = [...this.#queue];
    const [moved] = reordered.splice(sourceIndex, 1);
    if (moved === undefined) return false;
    const insertionIndex = reordered.indexOf(beforeTaskId);
    if (insertionIndex < 0) return false;
    this.#queueStore?.reorderQueued(taskId, beforeTaskId);
    reordered.splice(insertionIndex, 0, moved);
    this.#queue.splice(0, this.#queue.length, ...reordered);
    return true;
  }

  public queued(): readonly string[] {
    return [...this.#queue];
  }
}

export interface TaskQueueStore {
  queued(): readonly { readonly taskId: string }[];
  reorderQueued(taskId: string, beforeTaskId: string): readonly { readonly taskId: string }[];
}

function assertNoSecret(value: string): void {
  if (/^(?:Bearer\s+|sk-(?:proj-)?|ds-[A-Za-z0-9]|minimax-[A-Za-z0-9])/u.test(value)) {
    throw new Error("Secret-shaped content is forbidden in session entries.");
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

export {
  ApplyChangesGuard,
  ApplyChangesBlockedError,
  ApplyChangesService,
  AttachmentStore,
  ApprovalPolicy,
  BrowserControlError,
  BrowserRevisionError,
  FixedValidator,
  GitWorkspaceChangeTracker,
  GitWorktreeManager,
  InMemoryBrowserWorkspace,
  NonGitWorkspaceChangeTracker,
  LongRunningTaskRunner,
  LongRunningControlError,
  CommandValidator,
  ProviderConcurrencyGate,
  SerialMutationLane,
  WorkspaceHandoff,
  planGitWorktree,
} from "./v1.js";
export type {
  ActionKind,
  ActionRequest,
  ApplyChangesInput,
  AttachmentMetadata,
  ImageAttachmentPayload,
  BrowserAction,
  BrowserTabSnapshot,
  LongRunningResult,
  LongRunningStopReason,
  LongRunningProgress,
  LongRunningProgressBinding,
  LongRunningProgressStore,
  CommandRunner,
  CommandRunnerRequest,
  CommandRunnerResult,
  CommandValidatorCommand,
  Validator,
  ValidatorResult,
  GitWorktreePlan,
  GitChangeManifest,
  GitCommandRunner,
  WorkspaceChangeSnapshot,
  WorkspaceChangeTracker,
} from "./v1.js";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Turn aborted.");
  }
}
