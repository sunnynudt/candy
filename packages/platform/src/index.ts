import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { Entry } from "@napi-rs/keyring";

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

export type CandyModelId = "deepseek-v4-flash" | "deepseek-v4-pro" | "MiniMax-M3";
export const DEFAULT_CANDY_MODEL: CandyModelId = "deepseek-v4-flash";

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

export function resolveDefaultAppDataRoot(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const explicitRoot = environment.CANDY_APP_DATA_ROOT;
  if (explicitRoot !== undefined && explicitRoot !== "") {
    return platformPath.resolve(explicitRoot);
  }
  if (platform === "win32") {
    return platformPath.join(
      environment.LOCALAPPDATA ?? environment.APPDATA ?? homeDirectory,
      "Candy",
    );
  }
  if (platform === "darwin")
    return platformPath.join(homeDirectory, "Library", "Application Support", "Candy");
  return platformPath.join(homeDirectory, ".candy");
}

export type PersistedTaskState =
  "queued" | "running" | "waiting_approval" | "paused" | "interrupted" | "completed" | "cancelled";

export interface TaskMetadata {
  readonly taskId: string;
  readonly revision: number;
  readonly state: PersistedTaskState;
  readonly approvalProfile: "read-only" | "auto";
  readonly queueOrder?: number;
  readonly ownerId?: string;
  readonly model: CandyModelId;
  readonly attachmentIds: readonly string[];
  readonly workspacePath: string;
  readonly validator?: TaskValidatorSpec;
  readonly workspaceBaseline?: string;
  readonly worktreePath?: string;
}

export interface TaskValidatorSpec {
  readonly executable: string;
  readonly args: readonly string[];
}

export type PersistedRunStopReason =
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

export interface TaskRunMetadata {
  readonly taskId: string;
  readonly rounds: number;
  readonly evidenceCount: number;
  readonly completed: boolean;
  readonly stopReason: PersistedRunStopReason;
  readonly lastFingerprintHash?: string;
  readonly evidenceSummary?: string;
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
        owner_id TEXT,
        model_id TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
        attachment_ids TEXT NOT NULL DEFAULT '[]',
        workspace_path TEXT NOT NULL DEFAULT '',
        validator_json TEXT,
        workspace_baseline TEXT,
        worktree_path TEXT
      );
      CREATE TABLE IF NOT EXISTS task_runs (
        task_id TEXT PRIMARY KEY NOT NULL REFERENCES task_metadata(task_id) ON DELETE CASCADE,
        rounds INTEGER NOT NULL,
        evidence_count INTEGER NOT NULL,
        completed INTEGER NOT NULL,
        stop_reason TEXT NOT NULL,
        last_fingerprint_hash TEXT,
        evidence_summary TEXT
      );
      PRAGMA user_version = 9;
      `);
    } else if (schemaVersion === 1) {
      this.#database.exec(`
        ALTER TABLE task_metadata ADD COLUMN model_id TEXT NOT NULL DEFAULT 'deepseek-v4-flash';
        ALTER TABLE task_metadata ADD COLUMN attachment_ids TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE task_metadata ADD COLUMN workspace_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE task_metadata ADD COLUMN validator_json TEXT;
        ALTER TABLE task_metadata ADD COLUMN workspace_baseline TEXT;
        ALTER TABLE task_metadata ADD COLUMN worktree_path TEXT;
        CREATE TABLE IF NOT EXISTS task_runs (
          task_id TEXT PRIMARY KEY NOT NULL REFERENCES task_metadata(task_id) ON DELETE CASCADE,
          rounds INTEGER NOT NULL,
          evidence_count INTEGER NOT NULL,
          completed INTEGER NOT NULL,
          stop_reason TEXT NOT NULL,
          last_fingerprint_hash TEXT,
          evidence_summary TEXT
        );
        PRAGMA user_version = 9;
      `);
    } else if (schemaVersion === 2) {
      this.#database.exec(`
        ALTER TABLE task_metadata ADD COLUMN model_id TEXT NOT NULL DEFAULT 'deepseek-v4-flash';
        ALTER TABLE task_metadata ADD COLUMN attachment_ids TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE task_metadata ADD COLUMN workspace_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE task_metadata ADD COLUMN validator_json TEXT;
        ALTER TABLE task_metadata ADD COLUMN workspace_baseline TEXT;
        ALTER TABLE task_metadata ADD COLUMN worktree_path TEXT;
        ALTER TABLE task_runs ADD COLUMN evidence_summary TEXT;
        PRAGMA user_version = 9;
      `);
    } else if (schemaVersion === 3) {
      this.#database.exec(`
        ALTER TABLE task_metadata ADD COLUMN attachment_ids TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE task_metadata ADD COLUMN workspace_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE task_metadata ADD COLUMN validator_json TEXT;
        ALTER TABLE task_metadata ADD COLUMN workspace_baseline TEXT;
        ALTER TABLE task_metadata ADD COLUMN worktree_path TEXT;
        ALTER TABLE task_runs ADD COLUMN evidence_summary TEXT;
        PRAGMA user_version = 9;
      `);
    } else if (schemaVersion === 4) {
      this.#database.exec(`
        ALTER TABLE task_metadata ADD COLUMN workspace_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE task_metadata ADD COLUMN validator_json TEXT;
        ALTER TABLE task_metadata ADD COLUMN workspace_baseline TEXT;
        ALTER TABLE task_metadata ADD COLUMN worktree_path TEXT;
        ALTER TABLE task_runs ADD COLUMN evidence_summary TEXT;
        PRAGMA user_version = 9;
      `);
    } else if (schemaVersion === 5) {
      this.#database.exec(`
        ALTER TABLE task_metadata ADD COLUMN validator_json TEXT;
        ALTER TABLE task_metadata ADD COLUMN workspace_baseline TEXT;
        ALTER TABLE task_metadata ADD COLUMN worktree_path TEXT;
        ALTER TABLE task_runs ADD COLUMN evidence_summary TEXT;
        PRAGMA user_version = 9;
      `);
    } else if (schemaVersion === 6) {
      this.#database.exec(`
        ALTER TABLE task_metadata ADD COLUMN workspace_baseline TEXT;
        ALTER TABLE task_metadata ADD COLUMN worktree_path TEXT;
        ALTER TABLE task_runs ADD COLUMN evidence_summary TEXT;
        PRAGMA user_version = 9;
      `);
    } else if (schemaVersion === 7) {
      this.#database.exec(`
        ALTER TABLE task_metadata ADD COLUMN worktree_path TEXT;
        ALTER TABLE task_runs ADD COLUMN evidence_summary TEXT;
        PRAGMA user_version = 9;
      `);
    } else if (schemaVersion === 8) {
      this.#database.exec(`
        ALTER TABLE task_runs ADD COLUMN evidence_summary TEXT;
        PRAGMA user_version = 9;
      `);
    } else if (schemaVersion !== 9) {
      throw new Error(`Unsupported task metadata schema version: ${schemaVersion}.`);
    }
  }

  public create(
    taskId: string,
    approvalProfile: "read-only" | "auto",
    queueOrder?: number,
    model: CandyModelId = DEFAULT_CANDY_MODEL,
    attachmentIds: readonly string[] = [],
    workspacePath = process.cwd(),
    validator?: TaskValidatorSpec,
    workspaceBaseline?: string,
    worktreePath?: string,
  ): TaskMetadata {
    assertTaskId(taskId);
    assertAttachmentIds(attachmentIds);
    if (workspaceBaseline !== undefined && !/^[0-9a-f]{7,64}$/u.test(workspaceBaseline))
      throw new Error("Workspace baseline is invalid.");
    if (worktreePath !== undefined) assertWorkspacePath(worktreePath);
    this.#database
      .prepare(
        "INSERT INTO task_metadata (task_id, revision, state, approval_profile, queue_order, model_id, attachment_ids, workspace_path, validator_json, workspace_baseline, worktree_path) VALUES (?, 0, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        taskId,
        approvalProfile,
        queueOrder ?? null,
        model,
        JSON.stringify(attachmentIds),
        assertWorkspacePath(workspacePath),
        serializeValidator(validator),
        workspaceBaseline ?? null,
        worktreePath ?? null,
      );
    return this.require(taskId);
  }

  /** Persist a captured Git baseline without bumping the task revision. */
  public updateBaseline(taskId: string, baseline?: string): TaskMetadata {
    assertTaskId(taskId);
    if (baseline !== undefined && !/^[0-9a-f]{7,64}$/u.test(baseline))
      throw new Error("Workspace baseline is invalid.");
    this.#database
      .prepare(
        "UPDATE task_metadata SET workspace_baseline = COALESCE(workspace_baseline, ?) WHERE task_id = ? AND workspace_baseline IS NULL",
      )
      .run(baseline ?? null, taskId);
    return this.require(taskId);
  }

  /** Persist the associated Task Worktree path (or clear it after handoff). */
  public updateWorktree(taskId: string, worktreePath?: string): TaskMetadata {
    assertTaskId(taskId);
    if (worktreePath !== undefined) assertWorkspacePath(worktreePath);
    this.#database
      .prepare("UPDATE task_metadata SET worktree_path = ? WHERE task_id = ?")
      .run(worktreePath ?? null, taskId);
    return this.require(taskId);
  }

  public get(taskId: string): TaskMetadata | undefined {
    const row = this.#database
      .prepare(
        "SELECT task_id, revision, state, approval_profile, queue_order, owner_id, model_id, attachment_ids, workspace_path, validator_json, workspace_baseline, worktree_path FROM task_metadata WHERE task_id = ?",
      )
      .get(taskId);
    return row === undefined ? undefined : mapTaskMetadata(row);
  }

  public queued(): readonly TaskMetadata[] {
    return this.#database
      .prepare(
        "SELECT task_id, revision, state, approval_profile, queue_order, owner_id, model_id, attachment_ids, workspace_path, validator_json, workspace_baseline, worktree_path FROM task_metadata WHERE state = 'queued' ORDER BY queue_order IS NULL, queue_order, task_id",
      )
      .all()
      .map((row) => mapTaskMetadata(row));
  }

  /** Reorder one queued task before another without changing either task's execution state. */
  public reorderQueued(taskId: string, beforeTaskId: string): readonly TaskMetadata[] {
    assertTaskId(taskId);
    assertTaskId(beforeTaskId);
    if (taskId === beforeTaskId) throw new Error("A task cannot be reordered before itself.");
    const queue = [...this.queued()];
    const sourceIndex = queue.findIndex((task) => task.taskId === taskId);
    const targetIndex = queue.findIndex((task) => task.taskId === beforeTaskId);
    if (sourceIndex < 0 || targetIndex < 0) throw new Error("Only queued tasks can be reordered.");
    const [moved] = queue.splice(sourceIndex, 1);
    if (moved === undefined) throw new Error("Queued task is unavailable.");
    const insertionIndex = queue.findIndex((task) => task.taskId === beforeTaskId);
    if (insertionIndex < 0) throw new Error("Queued destination is unavailable.");
    queue.splice(insertionIndex, 0, moved);

    let transactionOpen = false;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const update = this.#database.prepare(
        "UPDATE task_metadata SET queue_order = ? WHERE task_id = ? AND state = 'queued'",
      );
      for (const [index, task] of queue.entries()) {
        if (update.run(index + 1, task.taskId).changes !== 1)
          throw new Error("Queued task changed while reordering.");
      }
      this.#database.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.queued();
  }

  public list(): readonly TaskMetadata[] {
    return this.#database
      .prepare(
        "SELECT task_id, revision, state, approval_profile, queue_order, owner_id, model_id, attachment_ids, workspace_path, validator_json, workspace_baseline, worktree_path FROM task_metadata ORDER BY task_id",
      )
      .all()
      .map((row) => mapTaskMetadata(row));
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

  public markOwnerInterrupted(ownerId: string): number {
    if (ownerId.length === 0) throw new Error("Task owner id is invalid.");
    return Number(
      this.#database
        .prepare(
          "UPDATE task_metadata SET revision = revision + 1, state = 'interrupted', owner_id = NULL WHERE owner_id = ? AND state IN ('running', 'waiting_approval')",
        )
        .run(ownerId).changes,
    );
  }

  public recordRun(progress: TaskRunMetadata): void {
    assertTaskId(progress.taskId);
    if (!Number.isSafeInteger(progress.rounds) || progress.rounds < 0)
      throw new Error("Task run rounds are invalid.");
    if (!Number.isSafeInteger(progress.evidenceCount) || progress.evidenceCount < 0)
      throw new Error("Task run evidence count is invalid.");
    if (
      progress.lastFingerprintHash !== undefined &&
      !/^[a-f0-9]{64}$/u.test(progress.lastFingerprintHash)
    ) {
      throw new Error("Task run fingerprint hash is invalid.");
    }
    if (
      progress.evidenceSummary !== undefined &&
      (progress.evidenceSummary.length > 4_096 || progress.evidenceSummary.includes("\0"))
    ) {
      throw new Error("Task run evidence summary is invalid.");
    }
    this.#database
      .prepare(
        `INSERT INTO task_runs
          (task_id, rounds, evidence_count, completed, stop_reason, last_fingerprint_hash, evidence_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
          rounds = excluded.rounds,
          evidence_count = excluded.evidence_count,
          completed = excluded.completed,
          stop_reason = excluded.stop_reason,
          last_fingerprint_hash = excluded.last_fingerprint_hash,
          evidence_summary = excluded.evidence_summary`,
      )
      .run(
        progress.taskId,
        progress.rounds,
        progress.evidenceCount,
        progress.completed ? 1 : 0,
        progress.stopReason,
        progress.lastFingerprintHash ?? null,
        progress.evidenceSummary ?? null,
      );
  }

  public getRun(taskId: string): TaskRunMetadata | undefined {
    const row = this.#database
      .prepare(
        "SELECT task_id, rounds, evidence_count, completed, stop_reason, last_fingerprint_hash, evidence_summary FROM task_runs WHERE task_id = ?",
      )
      .get(taskId);
    if (row === undefined) return undefined;
    return {
      taskId: String(row.task_id),
      rounds: Number(row.rounds),
      evidenceCount: Number(row.evidence_count),
      completed: Number(row.completed) === 1,
      stopReason: String(row.stop_reason) as PersistedRunStopReason,
      ...(row.last_fingerprint_hash === null
        ? {}
        : { lastFingerprintHash: String(row.last_fingerprint_hash) }),
      ...(row.evidence_summary === null || row.evidence_summary === undefined
        ? {}
        : { evidenceSummary: String(row.evidence_summary) }),
    };
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
  const validator = parseValidator(row.validator_json);
  const metadata = {
    taskId: String(row.task_id),
    revision: Number(row.revision),
    state: String(row.state) as PersistedTaskState,
    approvalProfile: String(row.approval_profile) as "read-only" | "auto",
    model: String(row.model_id ?? DEFAULT_CANDY_MODEL) as CandyModelId,
    attachmentIds: parseAttachmentIds(row.attachment_ids),
    workspacePath: String(row.workspace_path ?? ""),
    ...(validator === undefined ? {} : { validator }),
  };
  return {
    ...metadata,
    ...(row.queue_order !== null ? { queueOrder: Number(row.queue_order) } : {}),
    ...(row.owner_id !== null ? { ownerId: String(row.owner_id) } : {}),
    ...(row.workspace_baseline !== null
      ? { workspaceBaseline: String(row.workspace_baseline) }
      : {}),
    ...(row.worktree_path !== null && row.worktree_path !== ""
      ? { worktreePath: String(row.worktree_path) }
      : {}),
  };
}

function assertTaskId(taskId: string): void {
  if (taskId.length === 0 || /[\r\n]/u.test(taskId)) throw new Error("Task ID is invalid.");
}

function assertAttachmentIds(ids: readonly string[]): void {
  if (ids.some((id) => !/^att_[a-f0-9]{64}$/u.test(id)))
    throw new Error("Attachment id is invalid.");
}

function assertWorkspacePath(workspacePath: string): string {
  if (
    workspacePath.length === 0 ||
    workspacePath.includes("\0") ||
    workspacePath.includes("\r") ||
    workspacePath.includes("\n") ||
    !(
      workspacePath.startsWith("/") ||
      workspacePath.startsWith("\\\\") ||
      /^[A-Za-z]:[\\/]/u.test(workspacePath)
    )
  ) {
    throw new Error("Workspace path must be absolute.");
  }
  return workspacePath;
}

function serializeValidator(validator: TaskValidatorSpec | undefined): string | null {
  if (validator === undefined) return null;
  assertWorkspacePath(validator.executable);
  if (
    validator.args.some(
      (arg) =>
        arg.includes("\0") ||
        /(?:Bearer\s+|sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._~+/=-]{16,}/u.test(arg),
    )
  )
    throw new Error("Validator arguments cannot contain credential material.");
  return JSON.stringify({ executable: validator.executable, args: validator.args });
}

function parseValidator(value: unknown): TaskValidatorSpec | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { readonly executable?: unknown }).executable !== "string" ||
      !Array.isArray((parsed as { readonly args?: unknown }).args) ||
      (parsed as { readonly args: unknown[] }).args.some((arg) => typeof arg !== "string")
    )
      return undefined;
    const executable = (parsed as { readonly executable: string }).executable;
    const args = (parsed as { readonly args: string[] }).args;
    assertWorkspacePath(executable);
    if (
      args.some(
        (arg) =>
          arg.includes("\0") ||
          /(?:Bearer\s+|sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._~+/=-]{16,}/u.test(arg),
      )
    )
      return undefined;
    return { executable, args };
  } catch {
    return undefined;
  }
}

function parseAttachmentIds(value: unknown): readonly string[] {
  if (typeof value !== "string") return [];
  try {
    const ids = JSON.parse(value) as unknown;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return [];
    assertAttachmentIds(ids);
    return ids;
  } catch {
    return [];
  }
}

export type CredentialName = "deepseek" | "minimax-cn";
export type CredentialPresence = "present" | "absent";

export const CANDY_CREDENTIAL_ENV_KEYS = {
  deepseek: "CANDY_DEEPSEEK_API_KEY",
  "minimax-cn": "CANDY_MINIMAX_TOKEN_PLAN_KEY",
} as const satisfies Record<CredentialName, string>;

/**
 * Parse only the explicitly selected OpenCode DeepSeek API entry for the
 * local development importer. The caller owns the returned secret and must
 * write it directly to Candy's credential store without logging or projecting
 * it through another boundary.
 */
export function parseOpenCodeDeepSeekCredential(value: unknown): string {
  if (!isRecord(value)) throw new Error("OpenCode auth data must be an object.");
  const entry = value.deepseek;
  if (!isRecord(entry) || entry.type !== "api") {
    throw new Error("OpenCode DeepSeek API credential is unavailable.");
  }
  const key = entry.key;
  if (typeof key !== "string") throw new Error("OpenCode DeepSeek API key is unavailable.");
  assertCredentialValue(key);
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KEYRING_SERVICE = "candy-v1";
const KEYRING_ACCOUNTS = {
  deepseek: "deepseek",
  "minimax-cn": "minimax-token-plan",
} as const satisfies Record<CredentialName, string>;

export class CredentialStoreUnavailableError extends Error {
  public constructor(message = "Candy OS credential store is unavailable.") {
    super(message);
    this.name = "CredentialStoreUnavailableError";
  }
}

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

/**
 * Trusted OS credential-store adapter. It deliberately has no file or CLI
 * fallback: a missing native binding is a controlled capability error.
 */
export class KeyringCredentialStore implements CredentialStore {
  public set(name: CredentialName, value: string): void {
    assertCredentialValue(value);
    try {
      this.entry(name).setPassword(value);
    } catch (error) {
      throw new CredentialStoreUnavailableError(errorMessage(error));
    }
  }

  public replace(name: CredentialName, value: string): void {
    this.set(name, value);
  }

  public delete(name: CredentialName): void {
    try {
      this.entry(name).deleteCredential();
    } catch (error) {
      throw new CredentialStoreUnavailableError(errorMessage(error));
    }
  }

  public has(name: CredentialName): CredentialPresence {
    try {
      return this.entry(name).getPassword() === null ? "absent" : "present";
    } catch (error) {
      throw new CredentialStoreUnavailableError(errorMessage(error));
    }
  }

  public lease(name: CredentialName): SecretLease | undefined {
    try {
      const value = this.entry(name).getPassword();
      if (value === null || value.length === 0) return undefined;
      return { value, release: () => undefined };
    } catch (error) {
      throw new CredentialStoreUnavailableError(errorMessage(error));
    }
  }

  private entry(name: CredentialName): Entry {
    return new Entry(KEYRING_SERVICE, KEYRING_ACCOUNTS[name]);
  }
}

/** Resolve a Candy-owned temporary credential before consulting the OS store. */
export function resolveCredential(
  name: CredentialName,
  environment: NodeJS.ProcessEnv = process.env,
  store: CredentialStore = new KeyringCredentialStore(),
): SecretLease | undefined {
  const temporary = environment[CANDY_CREDENTIAL_ENV_KEYS[name]];
  if (temporary !== undefined) {
    assertCredentialValue(temporary);
    return { value: temporary, release: () => undefined };
  }
  return store.lease(name);
}

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "native credential store error";
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
