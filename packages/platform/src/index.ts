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
