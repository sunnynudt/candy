export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  public now(): number {
    return Date.now();
  }
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
