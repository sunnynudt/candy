import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAppPaths, SQLiteTaskStore } from "@candy/platform";
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

test("interactive TUI continues the current task and :new starts a different task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-continuation-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const turns: { readonly taskId: string; readonly prompt: string }[] = [];
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      turns.push({ taskId: input.taskId, prompt: input.prompt });
      yield { type: "turn.started", taskId: input.taskId };
      yield {
        type: "assistant.delta",
        taskId: input.taskId,
        text: `turn ${turns.length}: ${input.prompt}`,
      };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    const runPromise = new InteractiveTui({ appDataRoot: root, engine, terminal }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));

    terminal.emitInput("first request");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /turn 1: first request/u);
    terminal.emitInput("second request");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /turn 2: second request/u);
    assert.equal(turns[0]?.taskId, turns[1]?.taskId);

    terminal.emitInput(":new");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /new task ready/u);
    terminal.emitInput("third request");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /turn 3: third request/u);
    terminal.emitInput(":tasks");
    terminal.emitInput("\r");
    const output = await waitForOutput(terminal, /deepseek-v4-flash\t/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;

    assert.notEqual(turns[1]?.taskId, turns[2]?.taskId);
    assert.match(output, /\*task-/u);
    const store = new SQLiteTaskStore(path.join(resolveAppPaths(root).state, "tasks.sqlite"));
    assert.equal(store.list().filter((task) => task.state === "completed").length, 2);
    assert.ok(store.list().every((task) => task.model === "deepseek-v4-flash"));
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI restores a task and its transcript before continuing after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-restart-"));
  const firstTerminal: FakeTerminal = new FakeTerminal();
  const firstTurns: { readonly taskId: string; readonly prompt: string }[] = [];
  const firstEngine: TuiAgentEngine = {
    async *runTurn(input) {
      firstTurns.push({ taskId: input.taskId, prompt: input.prompt });
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "assistant.delta", taskId: input.taskId, text: "first persisted answer" };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    const firstRun = new InteractiveTui({
      appDataRoot: root,
      engine: firstEngine,
      terminal: firstTerminal,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    firstTerminal.emitInput("persist this context");
    firstTerminal.emitInput("\r");
    await waitForOutput(firstTerminal, /first persisted answer/u);
    firstTerminal.emitInput(":quit");
    firstTerminal.emitInput("\r");
    await firstRun;

    const before = new SQLiteTaskStore(path.join(resolveAppPaths(root).state, "tasks.sqlite"));
    const task = before.list()[0];
    assert.ok(task);
    assert.deepEqual(before.transcript(task.taskId), [
      { role: "user", text: "persist this context" },
      { role: "assistant", text: "first persisted answer" },
    ]);
    before.close();

    const secondTerminal: FakeTerminal = new FakeTerminal();
    const secondTurns: { readonly taskId: string; readonly prompt: string }[] = [];
    const secondEngine: TuiAgentEngine = {
      async *runTurn(input) {
        secondTurns.push({ taskId: input.taskId, prompt: input.prompt });
        yield { type: "turn.started", taskId: input.taskId };
        yield { type: "assistant.delta", taskId: input.taskId, text: "second persisted answer" };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const secondRun = new InteractiveTui({
      appDataRoot: root,
      engine: secondEngine,
      terminal: secondTerminal,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    secondTerminal.emitInput(":tasks");
    secondTerminal.emitInput("\r");
    await waitForOutput(secondTerminal, new RegExp(`${task.taskId}\\tcompleted\\t`));
    secondTerminal.emitInput(`:use ${task.taskId}`);
    secondTerminal.emitInput("\r");
    await waitForOutput(secondTerminal, new RegExp(`current task: ${task.taskId}`));
    secondTerminal.emitInput("continue from the saved context");
    secondTerminal.emitInput("\r");
    await waitForOutput(secondTerminal, /second persisted answer/u);
    secondTerminal.emitInput(":quit");
    secondTerminal.emitInput("\r");
    await secondRun;

    assert.deepEqual(secondTurns, [
      { taskId: task.taskId, prompt: "continue from the saved context" },
    ]);
    const after = new SQLiteTaskStore(path.join(resolveAppPaths(root).state, "tasks.sqlite"));
    assert.deepEqual(after.transcript(task.taskId), [
      { role: "user", text: "persist this context" },
      { role: "assistant", text: "first persisted answer" },
      { role: "user", text: "continue from the saved context" },
      { role: "assistant", text: "second persisted answer" },
    ]);
    after.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI rejects a second input while the current turn owns execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-active-owner-"));
  const terminal: FakeTerminal = new FakeTerminal();
  let started: (() => void) | undefined;
  let release: (() => void) | undefined;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      calls += 1;
      yield { type: "turn.started", taskId: input.taskId };
      started?.();
      await releasePromise;
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    const runPromise = new InteractiveTui({ appDataRoot: root, engine, terminal }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput("long turn");
    terminal.emitInput("\r");
    await startedPromise;
    terminal.emitInput("do not overlap");
    terminal.emitInput("\r");
    const output = await waitForOutput(terminal, /already running/u);
    assert.equal(calls, 1);
    release?.();
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
    assert.match(output, /already running/u);
  } finally {
    release?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI may inspect but cannot control a task owned by another client", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-non-owner-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const engineCalls: string[] = [];
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      engineCalls.push(input.taskId);
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  let external: SQLiteTaskStore | undefined;
  try {
    const runPromise = new InteractiveTui({ appDataRoot: root, engine, terminal }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    external = new SQLiteTaskStore(path.join(resolveAppPaths(root).state, "tasks.sqlite"));
    external.create("foreign-task", "read-only", 1, "deepseek-v4-flash", [], process.cwd());
    external.transition("foreign-task", 0, "running", "desktop-owner");
    terminal.emitInput(":use foreign-task");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /read-only task: foreign-task/u);
    terminal.emitInput("attempt foreign control");
    terminal.emitInput("\r");
    const output = await waitForOutput(terminal, /owned by desktop-owner/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
    assert.deepEqual(engineCalls, []);
    assert.match(output, /owned by desktop-owner/u);
  } finally {
    external?.close();
    await rm(root, { recursive: true, force: true });
  }
});
