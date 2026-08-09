import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  public now(): number {
    return Date.now();
  }
}

export interface AppPaths {
  readonly root: string;
  readonly sessions: string;
  readonly attachments: string;
  readonly state: string;
  readonly browserProfile: string;
  readonly worktrees: string;
}

export function resolveAppPaths(appDataRoot: string): AppPaths {
  const root = path.resolve(appDataRoot);
  return {
    root,
    sessions: path.join(root, "sessions"),
    attachments: path.join(root, "attachments"),
    state: path.join(root, "state"),
    browserProfile: path.join(root, "browser-profile"),
    worktrees: path.join(root, "worktrees"),
  };
}

export type PersistedTaskState =
  "queued" | "running" | "waiting_approval" | "paused" | "interrupted" | "completed" | "cancelled";

export interface TaskMetadata {
  readonly taskId: string;
  readonly revision: number;
  readonly state: PersistedTaskState;
  readonly approvalProfile: "read-only" | "auto";
  readonly queueOrder: number | undefined;
  readonly ownerId: string | undefined;
}

/**
 * Candy-owned durable task metadata. Session content and credentials are intentionally
 * not part of this schema; Pi session storage remains behind the adapter boundary.
 */
export class SQLiteTaskStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    if (databasePath !== ":memory:")
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: 2_500,
    });
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
    `);
    const schemaVersion = Number(
      (this.#database.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    if (schemaVersion === 0) {
      this.#database.exec(`
      CREATE TABLE IF NOT EXISTS task_metadata (
        task_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        approval_profile TEXT NOT NULL,
        queue_order INTEGER,
        owner_id TEXT
      );
      PRAGMA user_version = 1;
      `);
    } else if (schemaVersion !== 1) {
      throw new Error(`Unsupported task metadata schema version: ${schemaVersion}.`);
    }
  }

  public create(
    taskId: string,
    approvalProfile: "read-only" | "auto",
    queueOrder?: number,
  ): TaskMetadata {
    assertTaskId(taskId);
    this.#database
      .prepare(
        "INSERT INTO task_metadata (task_id, revision, state, approval_profile, queue_order) VALUES (?, 0, 'queued', ?, ?)",
      )
      .run(taskId, approvalProfile, queueOrder ?? null);
    return this.require(taskId);
  }

  public get(taskId: string): TaskMetadata | undefined {
    const row = this.#database
      .prepare(
        "SELECT task_id, revision, state, approval_profile, queue_order, owner_id FROM task_metadata WHERE task_id = ?",
      )
      .get(taskId);
    return row === undefined ? undefined : mapTaskMetadata(row);
  }

  public transition(
    taskId: string,
    expectedRevision: number,
    state: PersistedTaskState,
    ownerId?: string,
  ): TaskMetadata {
    const result = this.#database
      .prepare(
        "UPDATE task_metadata SET revision = revision + 1, state = ?, owner_id = ? WHERE task_id = ? AND revision = ?",
      )
      .run(state, ownerId ?? null, taskId, expectedRevision);
    if (result.changes !== 1) {
      throw new Error(`Task ${taskId} metadata revision is stale or missing.`);
    }
    return this.require(taskId);
  }

  public markActiveInterrupted(): number {
    return Number(
      this.#database
        .prepare(
          "UPDATE task_metadata SET revision = revision + 1, state = 'interrupted', owner_id = NULL WHERE state IN ('running', 'waiting_approval')",
        )
        .run().changes,
    );
  }

  public close(): void {
    this.#database.close();
  }

  private require(taskId: string): TaskMetadata {
    const metadata = this.get(taskId);
    if (!metadata) throw new Error(`Task ${taskId} metadata is missing.`);
    return metadata;
  }
}

function mapTaskMetadata(row: Record<string, unknown>): TaskMetadata {
  return {
    taskId: String(row.task_id),
    revision: Number(row.revision),
    state: String(row.state) as PersistedTaskState,
    approvalProfile: String(row.approval_profile) as "read-only" | "auto",
    queueOrder: row.queue_order === null ? undefined : Number(row.queue_order),
    ownerId: row.owner_id === null ? undefined : String(row.owner_id),
  };
}

function assertTaskId(taskId: string): void {
  if (taskId.length === 0 || /[\r\n]/u.test(taskId)) throw new Error("Task ID is invalid.");
}

export type CredentialName = "deepseek" | "minimax-cn";
export type CredentialPresence = "present" | "absent";

export interface SecretLease {
  readonly value: string;
  readonly release: () => void;
}

export interface CredentialStore {
  set(name: CredentialName, value: string): void;
  replace(name: CredentialName, value: string): void;
  delete(name: CredentialName): void;
  has(name: CredentialName): CredentialPresence;
  lease(name: CredentialName): SecretLease | undefined;
}

export class InMemoryCredentialStore implements CredentialStore {
  readonly #values = new Map<CredentialName, string>();

  public set(name: CredentialName, value: string): void {
    assertCredentialValue(value);
    if (this.#values.has(name)) throw new Error(`Credential ${name} already exists.`);
    this.#values.set(name, value);
  }

  public replace(name: CredentialName, value: string): void {
    assertCredentialValue(value);
    this.#values.set(name, value);
  }

  public delete(name: CredentialName): void {
    this.#values.delete(name);
  }

  public has(name: CredentialName): CredentialPresence {
    return this.#values.has(name) ? "present" : "absent";
  }

  public lease(name: CredentialName): SecretLease | undefined {
    const value = this.#values.get(name);
    if (!value) return undefined;
    return {
      value,
      release: () => undefined,
    };
  }

  public isReleased(name: CredentialName, value: string): boolean {
    void name;
    void value;
    return true;
  }
}

export const PROVIDER_ENV_KEYS = ["DEEPSEEK_API_KEY", "MINIMAX_API_KEY", "OPENAI_API_KEY"] as const;

export function cleanChildEnvironment(
  source: NodeJS.ProcessEnv,
  secretValues: readonly string[] = [],
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "ComSpec",
  ]) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  for (const value of secretValues) {
    for (const [key, candidate] of Object.entries(result)) {
      if (candidate?.includes(value)) delete result[key];
    }
  }
  return result;
}

function assertCredentialValue(value: string): void {
  if (value.length === 0 || /[\r\n]/u.test(value)) throw new Error("Credential value is invalid.");
}

export class ManualClock implements Clock {
  public constructor(private currentTime: number) {}

  public now(): number {
    return this.currentTime;
  }

  public advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("Clock advancement must be a non-negative safe integer.");
    }
    this.currentTime += milliseconds;
  }
}

export interface ExecutionLease {
  readonly taskId: string;
  readonly ownerId: string;
  readonly nonce: string;
  readonly generation: number;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
}

export interface LeaseIdentity {
  readonly taskId: string;
  readonly ownerId: string;
  readonly nonce: string;
  readonly generation: number;
}

export class LeaseConflictError extends Error {}
export class StaleLeaseError extends Error {}

export class InMemoryExecutionLeaseRepository {
  readonly #leases = new Map<string, ExecutionLease>();
  readonly #generation = new Map<string, number>();

  public constructor(
    private readonly clock: Clock,
    private readonly timeoutMs: number,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Lease timeout must be a positive safe integer.");
    }
  }

  public acquire(taskId: string, ownerId: string, nonce: string): ExecutionLease {
    const now = this.clock.now();
    const existing = this.#leases.get(taskId);
    if (existing && existing.expiresAt > now) {
      throw new LeaseConflictError(`Task ${taskId} already has an active owner.`);
    }

    const generation = (this.#generation.get(taskId) ?? 0) + 1;
    this.#generation.set(taskId, generation);
    const lease: ExecutionLease = {
      taskId,
      ownerId,
      nonce,
      generation,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + this.timeoutMs,
    };
    this.#leases.set(taskId, lease);
    return lease;
  }

  public heartbeat(identity: LeaseIdentity): ExecutionLease {
    const existing = this.#leases.get(identity.taskId);
    if (!existing || !sameIdentity(existing, identity) || existing.expiresAt <= this.clock.now()) {
      throw new StaleLeaseError(`Lease for task ${identity.taskId} is stale.`);
    }

    const now = this.clock.now();
    const renewed: ExecutionLease = {
      ...existing,
      heartbeatAt: now,
      expiresAt: now + this.timeoutMs,
    };
    this.#leases.set(identity.taskId, renewed);
    return renewed;
  }

  public release(identity: LeaseIdentity): void {
    const existing = this.#leases.get(identity.taskId);
    if (!existing || !sameIdentity(existing, identity)) {
      throw new StaleLeaseError(`Lease for task ${identity.taskId} is stale.`);
    }
    this.#leases.delete(identity.taskId);
  }

  public inspect(taskId: string): ExecutionLease | undefined {
    return this.#leases.get(taskId);
  }
}

function sameIdentity(lease: ExecutionLease, identity: LeaseIdentity): boolean {
  return (
    lease.taskId === identity.taskId &&
    lease.ownerId === identity.ownerId &&
    lease.nonce === identity.nonce &&
    lease.generation === identity.generation
  );
}
