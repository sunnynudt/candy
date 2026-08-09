import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManualClock, SQLiteTaskStore } from "@candy/platform";
import {
  BrowserUnavailableError,
  CandyRuntime,
  DeterministicAgentEngine,
  InMemorySessionStore,
  ReadOnlyWorkspaceTool,
  TaskController,
  TaskScheduler,
  UnavailableBrowserCapability,
  WorkspacePathError,
} from "./index.js";

test("deterministic agent engine drives a complete read-only turn", async () => {
  const clock = new ManualClock(1_000);
  const runtime = new CandyRuntime(
    new DeterministicAgentEngine(clock, "fixture response"),
    new UnavailableBrowserCapability(),
  );

  const observations = await runtime.runReadOnlyTurn(
    { taskId: "task-1", prompt: "inspect the fixture" },
    new AbortController().signal,
  );

  assert.deepEqual(observations, [
    { type: "turn.started", taskId: "task-1", at: 1_000 },
    { type: "assistant.delta", text: "fixture response" },
    { type: "turn.completed", taskId: "task-1", at: 1_000 },
  ]);
});

test("deterministic agent engine honors cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled by test"));
  const runtime = new CandyRuntime(
    new DeterministicAgentEngine(new ManualClock(0), "unused"),
    new UnavailableBrowserCapability(),
  );

  await assert.rejects(
    runtime.runReadOnlyTurn({ taskId: "task-1", prompt: "unused" }, controller.signal),
    /cancelled by test/u,
  );
});

test("TUI browser capability is explicitly unavailable", async () => {
  const browser = new UnavailableBrowserCapability();
  assert.equal(browser.available, false);
  await assert.rejects(
    browser.open("task-1", "https://example.invalid", new AbortController().signal),
    BrowserUnavailableError,
  );
});

test("read-only workspace tool contains paths and returns structured outcomes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-read-only-"));
  await writeFile(`${root}/fixture.txt`, "fixture content", "utf8");
  const tool = new ReadOnlyWorkspaceTool(root);
  const ok = await tool.read("fixture.txt", new AbortController().signal);
  assert.deepEqual(ok, { ok: true, path: "fixture.txt", content: "fixture content", bytes: 15 });
  assert.equal((await tool.read("missing.txt", new AbortController().signal)).error, "not_found");
  assert.equal(
    (await tool.read("../outside.txt", new AbortController().signal)).error,
    "outside_workspace",
  );
  assert.throws(() => tool.containedPath("../outside.txt"), WorkspacePathError);
});

test("session entries reject secret-shaped content and reload deterministically", async () => {
  const clock = new ManualClock(10);
  const sessions = new InMemorySessionStore(clock);
  await sessions.create("task-1", "session-1");
  await sessions.append("task-1", { type: "user", text: "inspect" });
  await sessions.append("task-1", { type: "assistant", text: "safe" });
  await assert.rejects(
    sessions.append("task-1", { type: "assistant", text: "Bearer canary" }),
    /Secret/u,
  );
  assert.deepEqual((await sessions.load("task-1")).entries, [
    { type: "user", text: "inspect" },
    { type: "assistant", text: "safe" },
  ]);
});

test("task controller fences stale revisions and scheduler preserves FIFO with a five-task hard limit", () => {
  const task = new TaskController("task-1");
  const running = task.setOwner("owner-1", 0);
  assert.equal(running.state, "running");
  assert.throws(() => task.transition("completed", 0), /stale/u);
  assert.equal(task.transition("completed", 1).state, "completed");

  const scheduler = new TaskScheduler();
  scheduler.enqueue("a");
  scheduler.enqueue("b");
  scheduler.enqueue("c");
  scheduler.enqueue("d");
  assert.deepEqual(scheduler.startAvailable(), ["a", "b", "c"]);
  scheduler.finish("a");
  assert.deepEqual(scheduler.startAvailable(), ["b", "c", "d"]);
  assert.throws(() => scheduler.startAvailable(6), /between 1 and 5/u);
});

test("task controller can reload and fence through the Candy metadata store", () => {
  const store = new SQLiteTaskStore(":memory:");
  const first = new TaskController("task-persisted", "read-only", store);
  const running = first.setOwner("owner-1", 0);
  assert.equal(running.revision, 1);

  const second = new TaskController("task-persisted", "read-only", store);
  assert.deepEqual(second.snapshot(), running);
  assert.throws(() => second.transition("completed", 0), /stale/u);
  assert.equal(first.transition("completed", 1).ownerId, undefined);
  assert.equal(store.get("task-persisted")?.state, "completed");
  store.close();
});
