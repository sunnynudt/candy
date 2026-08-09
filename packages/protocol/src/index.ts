export const PROTOCOL_VERSION = 1 as const;
export const MAX_JSONL_BYTES = 1024 * 1024;

export type TaskState = "idle" | "running" | "waiting_approval" | "paused" | "interrupted";

export interface TaskSnapshot {
  readonly taskId: string;
  readonly revision: number;
  readonly state: TaskState;
}

export interface SnapshotCommand {
  readonly type: "snapshot";
}

export type RuntimeCommand = SnapshotCommand;

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

export type RuntimeEvent = SnapshotEvent;

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
    value.state !== "running" &&
    value.state !== "waiting_approval" &&
    value.state !== "paused" &&
    value.state !== "interrupted"
  ) {
    throw new ProtocolValidationError("invalid_message", "snapshot.state is unsupported.");
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

  assertString(value.taskId, "taskId");

  if (value.kind === "command") {
    assertString(value.commandId, "commandId");
    assertNonNegativeInteger(value.expectedRevision, "expectedRevision");
    if (!isRecord(value.command) || value.command.type !== "snapshot") {
      throw new ProtocolValidationError("invalid_message", "Unsupported command payload.");
    }
    return value as unknown as CommandEnvelope;
  }

  if (value.kind === "event") {
    assertPositiveInteger(value.sequence, "sequence");
    assertNonNegativeInteger(value.revision, "revision");
    if (!isRecord(value.event) || value.event.type !== "snapshot") {
      throw new ProtocolValidationError("invalid_message", "Unsupported event payload.");
    }
    validateSnapshot(value.event.snapshot);
    if (
      value.event.snapshot.taskId !== value.taskId ||
      value.event.snapshot.revision !== value.revision
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
