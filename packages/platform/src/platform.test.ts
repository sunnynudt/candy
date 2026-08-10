import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InMemoryExecutionLeaseRepository,
  LeaseConflictError,
  ManualClock,
  InMemoryCredentialStore,
  resolveCredential,
  SQLiteTaskStore,
  StaleLeaseError,
  cleanChildEnvironment,
  resolveAppPaths,
  resolveDefaultAppDataRoot,
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

test("default app-data root uses platform-owned locations", () => {
  assert.equal(
    resolveDefaultAppDataRoot("darwin", {}, "/Users/test"),
    "/Users/test/Library/Application Support/Candy",
  );
  assert.equal(
    resolveDefaultAppDataRoot("win32", { LOCALAPPDATA: "C:/Local" }, "C:/Users/test"),
    "C:/Local/Candy",
  );
  assert.equal(resolveDefaultAppDataRoot("linux", {}, "/home/test"), "/home/test/.candy");
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

test("credential resolution uses only Candy-owned temporary variables before the OS store", () => {
  const store = new InMemoryCredentialStore();
  store.set("deepseek", "os-secret");
  const temporary = resolveCredential(
    "deepseek",
    { CANDY_DEEPSEEK_API_KEY: "temporary-secret", DEEPSEEK_API_KEY: "untrusted-name" },
    store,
  );
  assert.equal(temporary?.value, "temporary-secret");
  temporary?.release();
  assert.equal(resolveCredential("deepseek", {}, store)?.value, "os-secret");
});

test("sqlite task metadata survives restart and fences stale transitions", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-task-store-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const first = new SQLiteTaskStore(databasePath);
    const created = first.create("task-1", "read-only", 4);
    assert.deepEqual(created, {
      taskId: "task-1",
      revision: 0,
      state: "queued",
      approvalProfile: "read-only",
      queueOrder: 4,
      model: "deepseek-v4-flash",
    });
    const running = first.transition("task-1", 0, "running", "owner-1");
    assert.equal(running.revision, 1);
    const second = new SQLiteTaskStore(databasePath);
    assert.throws(() => second.transition("task-1", 0, "completed"), /stale or missing/);
    second.close();
    first.close();

    const reopened = new SQLiteTaskStore(databasePath);
    assert.deepEqual(reopened.get("task-1"), running);
    assert.equal(reopened.markActiveInterrupted(), 1);
    assert.equal(reopened.get("task-1")?.state, "interrupted");
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
