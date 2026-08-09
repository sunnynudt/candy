import assert from "node:assert/strict";
import test from "node:test";
import { ManualClock } from "@candy/platform";
import {
  BrowserUnavailableError,
  CandyRuntime,
  DeterministicAgentEngine,
  UnavailableBrowserCapability,
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
