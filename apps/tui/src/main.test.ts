import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { InteractiveTui, type TuiAgentEngine } from "./main.js";
import { FakeTerminal } from "./pi-tui-surface.js";

async function waitForOutput(terminal: FakeTerminal, pattern: RegExp): Promise<string> {
  for (let attempt: number = 0; attempt < 20; attempt += 1) {
    const output: string = terminal.writes.join("");
    if (pattern.test(output)) return output;
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
  }
  return terminal.writes.join("");
}

test("interactive TUI creates a queued task, runs it, and reports completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const engine: TuiAgentEngine = {
    async *runTurn(input, signal) {
      if (signal.aborted) throw new Error("cancelled");
      yield { type: "turn.started", taskId: input.taskId };
      yield {
        type: "assistant.delta",
        taskId: input.taskId,
        text: "fixture response sk-proj-tui-output-canary-123456",
      };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    const runPromise: Promise<void> = new InteractiveTui({
      appDataRoot: root,
      engine,
      terminal,
    }).run();
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
    terminal.emitInput("inspect fixture");
    terminal.emitInput("\r");
    const output: string = await waitForOutput(terminal, /completed/u);
    terminal.emitInput(":tasks");
    terminal.emitInput("\r");
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
    assert.match(output, /created task-/u);
    assert.match(output, /fixture response \[REDACTED\]/u);
    assert.doesNotMatch(output, /sk-proj-tui-output-canary-123456/u);
    assert.match(output, /completed/u);
    assert.match(output, /task-.*completed/u);
    assert.equal(terminal.started, true);
    assert.equal(terminal.stopped, true);
    assert.equal(terminal.drainCalls, 1);
    assert.equal(terminal.cursorShown, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI restores the terminal after a task error and Ctrl+C", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-error-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      yield { type: "turn.started", taskId: input.taskId };
      throw new Error("fixture failure");
    },
  };
  try {
    const runPromise: Promise<void> = new InteractiveTui({
      appDataRoot: root,
      engine,
      terminal,
    }).run();
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
    terminal.emitInput("inspect fixture");
    terminal.emitInput("\r");
    const output: string = await waitForOutput(terminal, /runtime error/u);
    assert.match(output, /runtime error/u);
    terminal.emitInput("\x03");
    await runPromise;
    assert.equal(terminal.stopped, true);
    assert.equal(terminal.drainCalls, 1);
    assert.equal(terminal.cursorShown, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI enables file Auto explicitly and confirms each delete", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-auto-"));
  const terminal: FakeTerminal = new FakeTerminal();
  let observedProfile: "read-only" | "auto" | undefined;
  let deleteApproved: boolean | undefined;
  const engine: TuiAgentEngine = {
    async *runTurn(input, signal) {
      observedProfile = input.approvalProfile;
      yield { type: "turn.started", taskId: input.taskId };
      deleteApproved = await input.fileDeleteApproval?.({ path: "obsolete.ts" }, signal);
      yield {
        type: "tool.completed",
        taskId: input.taskId,
        tool: "candy_delete",
        ok: deleteApproved === true,
      };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    const runPromise: Promise<void> = new InteractiveTui({
      appDataRoot: root,
      engine,
      terminal,
    }).run();
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
    terminal.emitInput(":profile auto");
    terminal.emitInput("\r");
    terminal.emitInput("remove the obsolete file");
    terminal.emitInput("\r");
    const approvalOutput = await waitForOutput(terminal, /approval required: delete obsolete\.ts/u);
    const approvalId = approvalOutput.match(/:approve (delete-[a-z0-9]+)/u)?.[1];
    assert.ok(approvalId);
    terminal.emitInput(`:approve ${approvalId}`);
    terminal.emitInput("\r");
    const completedOutput = await waitForOutput(terminal, /completed/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
    assert.equal(observedProfile, "auto");
    assert.equal(deleteApproved, true);
    assert.match(completedOutput, /\[tool candy_delete\]/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI keeps file mutation disabled until Auto is selected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-read-only-"));
  const terminal: FakeTerminal = new FakeTerminal();
  let observedProfile: "read-only" | "auto" | undefined;
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      observedProfile = input.approvalProfile;
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    const runPromise: Promise<void> = new InteractiveTui({
      appDataRoot: root,
      engine,
      terminal,
    }).run();
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
    terminal.emitInput("inspect only");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /completed/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
    assert.equal(observedProfile, "read-only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
