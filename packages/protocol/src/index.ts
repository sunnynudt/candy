export const PROTOCOL_VERSION = 1 as const;
export const MAX_JSONL_BYTES = 1024 * 1024;
export const MAX_TASK_ID_LENGTH = 128;

export function isSafeTaskId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TASK_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)
  );
}

export type CandyModelId = "deepseek-v4-flash" | "deepseek-v4-pro" | "MiniMax-M3";
export const DEFAULT_CANDY_MODEL: CandyModelId = "deepseek-v4-flash";

export type TaskState =
  | "idle"
  | "queued"
  | "running"
  | "waiting_approval"
  | "paused"
  | "interrupted"
  | "completed"
  | "cancelled";

export type TaskRunStopReason =
  | "running"
  | "validator_succeeded"
  | "budget_exhausted"
  | "stall_detected"
  | "cancelled"
  | "approval_required"
  | "ownership_lost"
  | "provider_failure"
  | "user_stop"
  | "crash_interrupted"
  | "error";

export interface TaskProgress {
  readonly rounds: number;
  readonly evidenceCount: number;
  readonly completed: boolean;
  readonly stopReason: TaskRunStopReason;
  readonly lastFingerprintHash?: string;
  readonly evidenceSummary?: string;
}

export interface TaskSnapshot {
  readonly taskId: string;
  readonly revision: number;
  readonly state: TaskState;
  readonly approvalProfile?: "read-only" | "auto";
  readonly model?: CandyModelId;
  readonly attachmentIds?: readonly string[];
  readonly workspacePath?: string;
  readonly workspaceBaseline?: string;
  readonly workspaceState?: "local" | "worktree";
  readonly worktreePath?: string;
  readonly ownerId?: string;
  readonly approvalId?: string;
  readonly trustedShell?: boolean;
  readonly shellApproval?: ShellApprovalRequest;
  readonly progress?: TaskProgress;
  readonly transcript?: readonly {
    readonly role: "user" | "assistant" | "tool";
    readonly text: string;
  }[];
}

export interface ShellApprovalRequest {
  readonly command: string;
  readonly cwd: string;
  readonly timeout?: number;
}

export interface SnapshotCommand {
  readonly type: "snapshot";
}

export interface CreateTaskCommand {
  readonly type: "task.create";
  readonly prompt: string;
  readonly approvalProfile: "read-only" | "auto";
  readonly workspacePath: string;
  readonly validator?: ValidatorSpec;
  readonly model?: CandyModelId;
  readonly attachmentIds?: readonly string[];
  readonly trustedShell?: boolean;
}

export interface ValidatorSpec {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface TaskActionCommand {
  readonly type: "task.run" | "task.cancel" | "task.pause" | "task.resume";
}

export interface TaskSteerCommand {
  readonly type: "task.steer";
  readonly text: string;
}

export interface TaskReorderCommand {
  readonly type: "task.reorder";
  readonly beforeTaskId: string;
}

export interface WorkspaceApplyCommand {
  readonly type: "workspace.apply";
  readonly expectedBase: string;
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
}

export interface WorkspaceDiscardCommand {
  readonly type: "workspace.discard";
}

export interface ApprovalCommand {
  readonly type: "approval.respond";
  readonly approvalId: string;
  readonly decision: "approve" | "deny";
}

export type RuntimeCommand =
  | SnapshotCommand
  | CreateTaskCommand
  | TaskActionCommand
  | TaskSteerCommand
  | TaskReorderCommand
  | WorkspaceApplyCommand
  | WorkspaceDiscardCommand
  | ApprovalCommand;

export interface CommandEnvelope {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: "command";
  readonly commandId: string;
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly command: RuntimeCommand;
}

export interface SnapshotEvent {
  readonly type: "snapshot";
  readonly snapshot: TaskSnapshot;
}

export interface TaskStateChangedEvent {
  readonly type: "task.state_changed";
  readonly state: TaskState;
  readonly reason?: "user" | "owner_lost" | "approval" | "validator" | "error";
}

export interface TaskCreatedEvent {
  readonly type: "task.created";
  readonly approvalProfile: "read-only" | "auto";
  readonly model?: CandyModelId;
  readonly attachmentIds?: readonly string[];
}

export interface AssistantDeltaEvent {
  readonly type: "assistant.delta";
  readonly text: string;
}

export interface AssistantThinkingDeltaEvent {
  readonly type: "assistant.thinking.delta";
  readonly text: string;
}

export interface ToolStartedEvent {
  readonly type: "tool.started";
  readonly tool: string;
}

export interface ToolCompletedEvent {
  readonly type: "tool.completed";
  readonly tool: string;
  readonly ok: boolean;
}

export interface TaskErrorEvent {
  readonly type: "task.error";
  readonly code: "cancelled" | "needs_credentials" | "provider_error" | "runtime_error";
}

export interface WorkspaceChangesEvent {
  readonly type: "workspace.changes";
  readonly available: boolean;
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
  readonly patchText: string;
  readonly patchTruncated: boolean;
}

export type RuntimeEvent =
  | SnapshotEvent
  | TaskStateChangedEvent
  | TaskCreatedEvent
  | AssistantThinkingDeltaEvent
  | AssistantDeltaEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | TaskErrorEvent
  | WorkspaceChangesEvent;

export interface EventEnvelope {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: "event";
  readonly taskId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly event: RuntimeEvent;
}

export type ProtocolMessage = CommandEnvelope | EventEnvelope;

export type ProtocolErrorCode =
  | "duplicate_command"
  | "invalid_message"
  | "line_too_large"
  | "out_of_sequence"
  | "secret_forbidden"
  | "stale_revision"
  | "unsupported_version";

export class ProtocolValidationError extends Error {
  public constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

const forbiddenKey =
  /^(authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|credential|cookie|set[-_]?cookie)$/iu;
const secretShapedValue = /^(?:Bearer\s+|sk-(?:proj-)?|ds-[A-Za-z0-9]|minimax-[A-Za-z0-9])/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeFields(value: unknown, path = "$"): void {
  if (typeof value === "string" && secretShapedValue.test(value)) {
    throw new ProtocolValidationError(
      "secret_forbidden",
      `Secret-shaped value is forbidden at ${path}.`,
    );
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeFields(item, `${path}[${index}]`));
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenKey.test(key)) {
      throw new ProtocolValidationError(
        "secret_forbidden",
        `Credential-bearing field ${path}.${key} is forbidden.`,
      );
    }
    assertSafeFields(nested, `${path}.${key}`);
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolValidationError("invalid_message", `${name} must be a non-empty string.`);
  }
}

function assertNonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolValidationError("invalid_message", `${name} must be a non-negative integer.`);
  }
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ProtocolValidationError("invalid_message", `${name} must be a positive integer.`);
  }
}

function validateSnapshot(value: unknown): asserts value is TaskSnapshot {
  if (!isRecord(value)) {
    throw new ProtocolValidationError("invalid_message", "snapshot must be an object.");
  }
  assertString(value.taskId, "snapshot.taskId");
  assertNonNegativeInteger(value.revision, "snapshot.revision");
  if (
    value.state !== "idle" &&
    value.state !== "queued" &&
    value.state !== "running" &&
    value.state !== "waiting_approval" &&
    value.state !== "paused" &&
    value.state !== "interrupted" &&
    value.state !== "completed" &&
    value.state !== "cancelled"
  ) {
    throw new ProtocolValidationError("invalid_message", "snapshot.state is unsupported.");
  }
  if (
    value.model !== undefined &&
    value.model !== "deepseek-v4-flash" &&
    value.model !== "deepseek-v4-pro" &&
    value.model !== "MiniMax-M3"
  ) {
    throw new ProtocolValidationError("invalid_message", "model is unsupported.");
  }
  if (value.workspaceBaseline !== undefined)
    assertBaseCommit(value.workspaceBaseline, "snapshot.workspaceBaseline");
  if (value.trustedShell !== undefined && typeof value.trustedShell !== "boolean")
    throw new ProtocolValidationError("invalid_message", "snapshot.trustedShell is invalid.");
  if (value.shellApproval !== undefined) validateShellApproval(value.shellApproval);
  if (
    value.workspaceState !== undefined &&
    value.workspaceState !== "local" &&
    value.workspaceState !== "worktree"
  ) {
    throw new ProtocolValidationError("invalid_message", "snapshot.workspaceState is unsupported.");
  }
  if (value.worktreePath !== undefined)
    assertWorkspacePath(value.worktreePath, "snapshot.worktreePath");
  if (value.approvalId !== undefined) assertString(value.approvalId, "snapshot.approvalId");
  if (value.progress !== undefined) validateTaskProgress(value.progress);
  if (value.transcript !== undefined) {
    if (
      !Array.isArray(value.transcript) ||
      value.transcript.length > 1_024 ||
      value.transcript.some(
        (entry) =>
          typeof entry !== "object" ||
          entry === null ||
          (entry.role !== "user" && entry.role !== "assistant" && entry.role !== "tool") ||
          typeof entry.text !== "string" ||
          entry.text.length === 0 ||
          entry.text.length > 4_096 ||
          entry.text.includes("\0"),
      )
    ) {
      throw new ProtocolValidationError("invalid_message", "snapshot.transcript is invalid.");
    }
  }
}

function validateTaskProgress(value: unknown): asserts value is TaskProgress {
  if (!isRecord(value))
    throw new ProtocolValidationError("invalid_message", "snapshot.progress is invalid.");
  assertNonNegativeInteger(value.rounds, "snapshot.progress.rounds");
  assertNonNegativeInteger(value.evidenceCount, "snapshot.progress.evidenceCount");
  if (typeof value.completed !== "boolean")
    throw new ProtocolValidationError("invalid_message", "snapshot.progress.completed is invalid.");
  const stopReasons: readonly TaskRunStopReason[] = [
    "running",
    "validator_succeeded",
    "budget_exhausted",
    "stall_detected",
    "cancelled",
    "approval_required",
    "ownership_lost",
    "provider_failure",
    "user_stop",
    "crash_interrupted",
    "error",
  ];
  if (!stopReasons.includes(value.stopReason as TaskRunStopReason))
    throw new ProtocolValidationError(
      "invalid_message",
      "snapshot.progress.stopReason is invalid.",
    );
  if (
    value.lastFingerprintHash !== undefined &&
    (typeof value.lastFingerprintHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.lastFingerprintHash))
  ) {
    throw new ProtocolValidationError(
      "invalid_message",
      "snapshot.progress.lastFingerprintHash is invalid.",
    );
  }
  if (
    value.evidenceSummary !== undefined &&
    (typeof value.evidenceSummary !== "string" ||
      value.evidenceSummary.length > 4_096 ||
      value.evidenceSummary.includes("\0"))
  ) {
    throw new ProtocolValidationError(
      "invalid_message",
      "snapshot.progress.evidenceSummary is invalid.",
    );
  }
}

function validateShellApproval(value: unknown): asserts value is ShellApprovalRequest {
  if (!isRecord(value))
    throw new ProtocolValidationError("invalid_message", "snapshot.shellApproval is invalid.");
  assertString(value.command, "snapshot.shellApproval.command");
  assertWorkspacePath(value.cwd, "snapshot.shellApproval.cwd");
  if (
    value.timeout !== undefined &&
    (typeof value.timeout !== "number" || !Number.isFinite(value.timeout) || value.timeout <= 0)
  )
    throw new ProtocolValidationError(
      "invalid_message",
      "snapshot.shellApproval.timeout is invalid.",
    );
}

function validateCommand(value: unknown): asserts value is RuntimeCommand {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ProtocolValidationError("invalid_message", "Unsupported command payload.");
  }
  if (
    value.type === "snapshot" ||
    value.type === "task.run" ||
    value.type === "task.cancel" ||
    value.type === "task.pause" ||
    value.type === "task.resume"
  )
    return;
  if (value.type === "task.steer") {
    assertString(value.text, "command.text");
    if (value.text.length > 100_000 || value.text.includes("\0"))
      throw new ProtocolValidationError("invalid_message", "command.text is too large.");
    return;
  }
  if (value.type === "task.reorder") {
    assertString(value.beforeTaskId, "command.beforeTaskId");
    return;
  }
  if (value.type === "task.create") {
    assertString(value.prompt, "command.prompt");
    assertWorkspacePath(value.workspacePath, "command.workspacePath");
    if (value.validator !== undefined) validateValidatorSpec(value.validator);
    if (value.approvalProfile !== "read-only" && value.approvalProfile !== "auto") {
      throw new ProtocolValidationError(
        "invalid_message",
        "command.approvalProfile is unsupported.",
      );
    }
    if (value.trustedShell !== undefined && typeof value.trustedShell !== "boolean") {
      throw new ProtocolValidationError(
        "invalid_message",
        "command.trustedShell must be a boolean.",
      );
    }
    if (value.trustedShell === true && value.approvalProfile !== "auto") {
      throw new ProtocolValidationError(
        "invalid_message",
        "Personal Preview Shell requires the Auto approval profile.",
      );
    }
    if (
      value.model !== undefined &&
      value.model !== "deepseek-v4-flash" &&
      value.model !== "deepseek-v4-pro" &&
      value.model !== "MiniMax-M3"
    ) {
      throw new ProtocolValidationError("invalid_message", "command.model is unsupported.");
    }
    if (value.attachmentIds !== undefined) assertAttachmentIds(value.attachmentIds);
    return;
  }
  if (value.type === "workspace.apply") {
    assertBaseCommit(value.expectedBase, "command.expectedBase");
    assertRelativePaths(value.tracked, "command.tracked");
    assertRelativePaths(value.untracked, "command.untracked");
    return;
  }
  if (value.type === "workspace.discard") return;
  if (value.type === "approval.respond") {
    assertString(value.approvalId, "command.approvalId");
    if (value.decision !== "approve" && value.decision !== "deny") {
      throw new ProtocolValidationError("invalid_message", "command.decision is unsupported.");
    }
    return;
  }
  throw new ProtocolValidationError("invalid_message", "Unsupported command payload.");
}

function assertWorkspacePath(value: unknown, name: string): asserts value is string {
  assertString(value, name);
  if (
    !pathLikeIsAbsolute(value) ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new ProtocolValidationError("invalid_message", `${name} must be an absolute path.`);
  }
}

function pathLikeIsAbsolute(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/u.test(value);
}

function validateValidatorSpec(value: unknown): asserts value is ValidatorSpec {
  if (!isRecord(value))
    throw new ProtocolValidationError("invalid_message", "command.validator is invalid.");
  assertWorkspacePath(value.executable, "command.validator.executable");
  if (
    !Array.isArray(value.args) ||
    value.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    throw new ProtocolValidationError("invalid_message", "command.validator.args is invalid.");
  }
}

function validateEvent(value: unknown): asserts value is RuntimeEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ProtocolValidationError("invalid_message", "Unsupported event payload.");
  }
  if (value.type === "snapshot") {
    validateSnapshot(value.snapshot);
    return;
  }
  if (value.type === "task.state_changed") {
    if (typeof value.state !== "string")
      throw new ProtocolValidationError("invalid_message", "event.state is invalid.");
    validateSnapshot({ taskId: "event", revision: 0, state: value.state });
    return;
  }
  if (value.type === "task.created") {
    if (value.approvalProfile !== "read-only" && value.approvalProfile !== "auto")
      throw new ProtocolValidationError("invalid_message", "event.approvalProfile is invalid.");
    if (
      value.model !== undefined &&
      value.model !== "deepseek-v4-flash" &&
      value.model !== "deepseek-v4-pro" &&
      value.model !== "MiniMax-M3"
    ) {
      throw new ProtocolValidationError("invalid_message", "event.model is unsupported.");
    }
    if (value.attachmentIds !== undefined) assertAttachmentIds(value.attachmentIds);
    return;
  }
  if (value.type === "assistant.delta") {
    assertString(value.text, "event.text");
    return;
  }
  if (value.type === "assistant.thinking.delta") {
    assertString(value.text, "event.text");
    return;
  }
  if (value.type === "tool.started") {
    assertString(value.tool, "event.tool");
    return;
  }
  if (value.type === "tool.completed") {
    assertString(value.tool, "event.tool");
    if (typeof value.ok !== "boolean")
      throw new ProtocolValidationError("invalid_message", "event.ok is invalid.");
    return;
  }
  if (value.type === "task.error") {
    if (
      value.code !== "cancelled" &&
      value.code !== "needs_credentials" &&
      value.code !== "provider_error" &&
      value.code !== "runtime_error"
    ) {
      throw new ProtocolValidationError("invalid_message", "event.code is invalid.");
    }
    return;
  }
  if (value.type === "workspace.changes") {
    if (
      typeof value.available !== "boolean" ||
      typeof value.patchText !== "string" ||
      typeof value.patchTruncated !== "boolean"
    ) {
      throw new ProtocolValidationError("invalid_message", "workspace changes are invalid.");
    }
    assertRelativePaths(value.tracked, "event.tracked");
    assertRelativePaths(value.untracked, "event.untracked");
    return;
  }
  throw new ProtocolValidationError("invalid_message", "Unsupported event payload.");
}

function assertRelativePaths(value: unknown, name: string): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.includes("\0") ||
        entry.includes("\\") ||
        entry === "." ||
        entry.startsWith("/") ||
        entry.startsWith("../") ||
        entry.includes("/../") ||
        entry.endsWith("/.."),
    )
  ) {
    throw new ProtocolValidationError("invalid_message", `${name} must contain relative paths.`);
  }
}

function assertAttachmentIds(value: unknown): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== "string" || !/^att_[a-f0-9]{64}$/u.test(id))
  ) {
    throw new ProtocolValidationError("invalid_message", "attachmentIds are invalid.");
  }
}

function assertBaseCommit(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{7,64}$/u.test(value)) {
    throw new ProtocolValidationError("invalid_message", `${name} must be a Git commit id.`);
  }
}

export function validateProtocolMessage(value: unknown): ProtocolMessage {
  assertSafeFields(value);
  if (!isRecord(value)) {
    throw new ProtocolValidationError("invalid_message", "Protocol message must be an object.");
  }

  if (value.v !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      "unsupported_version",
      `Protocol version must be ${PROTOCOL_VERSION}.`,
    );
  }

  if (!isSafeTaskId(value.taskId)) {
    throw new ProtocolValidationError("invalid_message", "taskId is invalid.");
  }

  if (value.kind === "command") {
    assertString(value.commandId, "commandId");
    assertNonNegativeInteger(value.expectedRevision, "expectedRevision");
    validateCommand(value.command);
    return value as unknown as CommandEnvelope;
  }

  if (value.kind === "event") {
    assertPositiveInteger(value.sequence, "sequence");
    assertNonNegativeInteger(value.revision, "revision");
    validateEvent(value.event);
    if (
      value.event.type === "snapshot" &&
      (value.event.snapshot.taskId !== value.taskId ||
        value.event.snapshot.revision !== value.revision)
    ) {
      throw new ProtocolValidationError(
        "invalid_message",
        "Snapshot identity and revision must match the event envelope.",
      );
    }
    return value as unknown as EventEnvelope;
  }

  throw new ProtocolValidationError("invalid_message", "Protocol kind is unsupported.");
}

export function encodeJsonLine(message: ProtocolMessage): string {
  validateProtocolMessage(message);
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_JSONL_BYTES) {
    throw new ProtocolValidationError("line_too_large", "Encoded protocol line is too large.");
  }
  return line;
}

export function decodeJsonLine(line: string): ProtocolMessage {
  if (Buffer.byteLength(line, "utf8") > MAX_JSONL_BYTES) {
    throw new ProtocolValidationError("line_too_large", "Protocol line is too large.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ProtocolValidationError("invalid_message", "Protocol line is not valid JSON.");
  }
  return validateProtocolMessage(parsed);
}

export class CommandLedger {
  readonly #commandIds = new Set<string>();

  public accept(command: CommandEnvelope, currentRevision: number): void {
    if (this.#commandIds.has(command.commandId)) {
      throw new ProtocolValidationError(
        "duplicate_command",
        `Command ${command.commandId} was already accepted.`,
      );
    }
    if (command.expectedRevision !== currentRevision) {
      throw new ProtocolValidationError(
        "stale_revision",
        `Expected revision ${command.expectedRevision}; current revision is ${currentRevision}.`,
      );
    }
    this.#commandIds.add(command.commandId);
  }
}

interface EventPosition {
  readonly sequence: number;
  readonly revision: number;
}

export class EventLedger {
  readonly #positions = new Map<string, EventPosition>();

  public accept(event: EventEnvelope): void {
    const current = this.#positions.get(event.taskId);
    const expectedSequence = (current?.sequence ?? 0) + 1;
    if (event.sequence !== expectedSequence) {
      throw new ProtocolValidationError(
        "out_of_sequence",
        `Expected sequence ${expectedSequence}; received ${event.sequence}.`,
      );
    }
    if (current && event.revision < current.revision) {
      throw new ProtocolValidationError(
        "stale_revision",
        `Event revision ${event.revision} precedes current revision ${current.revision}.`,
      );
    }
    this.#positions.set(event.taskId, {
      sequence: event.sequence,
      revision: event.revision,
    });
  }
}
