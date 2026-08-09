import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryExecutionLeaseRepository,
  LeaseConflictError,
  ManualClock,
  StaleLeaseError,
} from "./index.js";

test("manual clock advances deterministically", () => {
  const clock = new ManualClock(100);
  clock.advance(50);
  assert.equal(clock.now(), 150);
});

test("execution leases fence expired owners", () => {
  const clock = new ManualClock(1_000);
  const leases = new InMemoryExecutionLeaseRepository(clock, 500);
  const first = leases.acquire("task-1", "owner-1", "nonce-1");

  assert.throws(() => leases.acquire("task-1", "owner-2", "nonce-2"), LeaseConflictError);
  clock.advance(501);
  const second = leases.acquire("task-1", "owner-2", "nonce-2");

  assert.equal(second.generation, first.generation + 1);
  assert.throws(() => leases.heartbeat(first), StaleLeaseError);
  assert.equal(leases.heartbeat(second).ownerId, "owner-2");
});
