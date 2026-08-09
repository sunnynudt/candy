import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  InMemoryExecutionLeaseRepository,
  LeaseConflictError,
  ManualClock,
  InMemoryCredentialStore,
  StaleLeaseError,
  cleanChildEnvironment,
  resolveAppPaths,
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

test("app-data paths are Candy-owned and platform-neutral", () => {
  const paths = resolveAppPaths("Candy Data");
  assert.deepEqual(paths, {
    root: path.resolve("Candy Data"),
    sessions: path.join(path.resolve("Candy Data"), "sessions"),
    attachments: path.join(path.resolve("Candy Data"), "attachments"),
    state: path.join(path.resolve("Candy Data"), "state"),
    browserProfile: path.join(path.resolve("Candy Data"), "browser-profile"),
    worktrees: path.join(path.resolve("Candy Data"), "worktrees"),
  });
});

test("credential store exposes presence and short-lived leases without renderer readback", () => {
  const credentials = new InMemoryCredentialStore();
  assert.equal(credentials.has("deepseek"), "absent");
  credentials.set("deepseek", "fixture-secret");
  assert.equal(credentials.has("deepseek"), "present");
  assert.equal(credentials.lease("deepseek")?.value, "fixture-secret");
  credentials.replace("deepseek", "replacement");
  credentials.delete("deepseek");
  assert.equal(credentials.has("deepseek"), "absent");
});

test("child environment is allowlisted and removes values containing active secrets", () => {
  const environment = cleanChildEnvironment(
    { PATH: "path", HOME: "home", DEEPSEEK_API_KEY: "fixture-secret", CUSTOM: "ignored" },
    ["fixture-secret"],
  );
  assert.equal(environment.PATH, "path");
  assert.equal(environment.HOME, "home");
  assert.equal(environment.DEEPSEEK_API_KEY, undefined);
  assert.equal(environment.CUSTOM, undefined);
});
