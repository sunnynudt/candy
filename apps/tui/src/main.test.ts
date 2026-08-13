import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderContractError } from "@candy/pi-adapter";
import { resolveAppPaths, SQLiteTaskStore } from "@candy/platform";
import type {
  CommandValidatorCommand,
  ValidatorResult,
  WorkspaceChangeSnapshot,
  WorkspaceChangeTracker,
} from "@candy/runtime";
import { InteractiveTui, type TuiAgentEngine } from "./main.js";
import { FakeTerminal } from "./pi-tui-surface.js";

async function waitForOutput(terminal: FakeTerminal, pattern: RegExp): Promise<string> {
  for (let attempt: number = 0; attempt < 500; attempt += 1) {
    const output: string = terminal.writes.join("");
    if (pattern.test(output)) return output;
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 1);
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

test("interactive TUI exposes sanitized provider recovery actions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-provider-recovery-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      yield { type: "turn.started", taskId: input.taskId };
      throw new ProviderContractError("Provider request timed out.", "provider_error", "timeout");
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
    const output: string = await waitForOutput(terminal, /provider request timed out/u);
    const taskId = output.match(/created (task-[a-z0-9]+)/u)?.[1];
    assert.ok(taskId);
    assert.match(
      output,
      new RegExp(`recovery: :resume ${taskId}, :model deepseek-pro, or :cancel`, "u"),
    );
    assert.doesNotMatch(output, /fixture-secret|Bearer\s+|sk-proj-/iu);
    terminal.emitInput(`:cancel ${taskId}`);
    terminal.emitInput("\r");
    await waitForOutput(terminal, new RegExp(`${taskId} cancelled`, "u"));
    terminal.emitInput("\x03");
    await runPromise;
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
    secondTerminal.emitInput(":transcript");
    secondTerminal.emitInput("\r");
    const transcriptOutput = await waitForOutput(
      secondTerminal,
      /transcript task-[^\n]+\nuser: persist this context[\s\S]*second persisted answer/u,
    );
    secondTerminal.emitInput(":quit");
    secondTerminal.emitInput("\r");
    await secondRun;

    assert.deepEqual(secondTurns, [
      { taskId: task.taskId, prompt: "continue from the saved context" },
    ]);
    assert.match(transcriptOutput, /user: persist this context/u);
    assert.match(transcriptOutput, /assistant: first persisted answer/u);
    assert.match(transcriptOutput, /user: continue from the saved context/u);
    assert.match(transcriptOutput, /assistant: second persisted answer/u);
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

test("interactive TUI reviews non-Git changed files and bounded diff without mutating the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-changes-nongit-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-tui-changes-workspace-"));
  const terminal = new FakeTerminal();
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      await writeFile(path.join(input.cwd, "new.ts"), "created by fixture\n");
      await unlink(path.join(input.cwd, "obsolete.ts"));
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    await writeFile(path.join(workspace, "obsolete.ts"), "before\n");
    const runPromise = new InteractiveTui({
      appDataRoot: root,
      workspacePath: workspace,
      engine,
      terminal,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput("review workspace");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /completed/u);
    terminal.emitInput(":changes");
    terminal.emitInput("\r");
    const changes = await waitForOutput(terminal, /changed files:/u);
    assert.match(changes, /new\.ts/u);
    assert.match(changes, /obsolete\.ts/u);
    terminal.emitInput(":diff");
    terminal.emitInput("\r");
    const diff = await waitForOutput(terminal, /changed: new\.ts/u);
    assert.match(diff, /changed: obsolete\.ts/u);
    assert.equal(await readWorkspaceFile(workspace, "new.ts"), "created by fixture\n");
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("interactive TUI reviews Git tracked, untracked, removed files and filters diff paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-changes-git-"));
  const terminal = new FakeTerminal();
  const changes: WorkspaceChangeSnapshot = {
    available: true,
    tracked: ["src/value.ts", "old.ts"],
    untracked: ["notes.txt"],
    patchText:
      "diff --git a/src/value.ts b/src/value.ts\n@@ -1 +1 @@\n-old\n+new\n" +
      "diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n",
    patchTruncated: false,
  };
  const changeTracker: WorkspaceChangeTracker = {
    async captureBaseline() {
      return "0123456789abcdef";
    },
    async inspect() {
      return changes;
    },
  };
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    const runPromise = new InteractiveTui({
      appDataRoot: root,
      engine,
      terminal,
      changeTracker,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput("review git workspace");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /completed/u);
    terminal.emitInput(":changes");
    terminal.emitInput("\r");
    const changesOutput = await waitForOutput(terminal, /removed:/u);
    assert.match(changesOutput, /tracked: src\/value\.ts/u);
    assert.match(changesOutput, /untracked: notes\.txt/u);
    assert.match(changesOutput, /removed: old\.ts/u);
    terminal.emitInput(":diff src/value.ts");
    terminal.emitInput("\r");
    const diffOutput = await waitForOutput(terminal, /@@ -1 \+1 @@/u);
    assert.match(diffOutput, /src\/value\.ts/u);
    assert.doesNotMatch(diffOutput, /deleted file mode/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI bounds a large diff before rendering it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-large-diff-"));
  const terminal = new FakeTerminal();
  const largePatch = `diff --git a/src/large.ts b/src/large.ts\n${"+line\n".repeat(20_000)}`;
  const changeTracker: WorkspaceChangeTracker = {
    async captureBaseline() {
      return "0123456789abcdef";
    },
    async inspect() {
      return {
        available: true,
        tracked: ["src/large.ts"],
        untracked: [],
        patchText: largePatch,
        patchTruncated: false,
      };
    },
  };
  try {
    const runPromise = new InteractiveTui({
      appDataRoot: root,
      changeTracker,
      engine: {
        async *runTurn(input) {
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
      terminal,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput("review large diff");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /completed/u);
    terminal.emitInput(":diff");
    terminal.emitInput("\r");
    const output = await waitForOutput(terminal, /diff truncated at 65536 bytes/u);
    assert.match(output, /diff truncated at 65536 bytes/u);
    assert.ok(
      Math.max(...terminal.writes.map((write) => Buffer.byteLength(write, "utf8"))) < 70 * 1024,
    );
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI projects explicit validator pass, fail, cancel, and timeout safely", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-validator-"));
  const terminal = new FakeTerminal();
  const results = new Map<string, ValidatorResult>([
    ["pass", { ok: true, fingerprint: "pass", evidence: "validator passed", durationMs: 1 }],
    [
      "fail",
      {
        ok: false,
        fingerprint: "fail",
        evidence: "validator failed fixture-secret",
        durationMs: 2,
      },
    ],
  ]);
  const validator = {
    run: async (
      command: CommandValidatorCommand,
      _workspace: string,
      signal: AbortSignal,
    ): Promise<ValidatorResult> => {
      const mode = command.args[0];
      const result = results.get(mode ?? "");
      if (result !== undefined) return result;
      if (mode === "cancel") {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("validator cancelled")), {
            once: true,
          });
        });
      }
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("timeout")), {
          once: true,
        });
      });
      throw new Error("validator did not stop");
    },
  };
  const taskIds: string[] = [];
  const createAndValidate = async (mode: string, expected: RegExp): Promise<string> => {
    terminal.emitInput(`:validator ${process.execPath} ${mode}`);
    terminal.emitInput("\r");
    terminal.emitInput(":new");
    terminal.emitInput("\r");
    terminal.emitInput(`run ${mode}`);
    terminal.emitInput("\r");
    const created = await waitForOutput(terminal, /created (task-[a-z0-9]+)/u);
    const taskId = [...created.matchAll(/created (task-[a-z0-9]+)/gu)].at(-1)?.[1];
    assert.ok(taskId);
    taskIds.push(taskId);
    await waitForOutput(terminal, /completed/u);
    terminal.emitInput(":validate");
    terminal.emitInput("\r");
    await waitForOutput(terminal, expected);
    return taskId;
  };
  try {
    const runPromise = new InteractiveTui({
      appDataRoot: root,
      engine: {
        async *runTurn(input) {
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
      terminal,
      validator,
      validatorTimeoutMs: 5,
      activeSecrets: () => ["fixture-secret"],
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await createAndValidate("pass", /validator pass/u);
    await createAndValidate("fail", /validator fail/u);
    const cancelledTask = await createAndValidate("cancel", /validator running/u);
    terminal.emitInput(`:cancel ${cancelledTask}`);
    terminal.emitInput("\r");
    await waitForOutput(terminal, /validator cancelled/u);
    await createAndValidate("timeout", /validator running/u);
    await waitForOutput(terminal, /validator timeout/u);
    const store = new SQLiteTaskStore(path.join(resolveAppPaths(root).state, "tasks.sqlite"));
    assert.equal(store.list().length, taskIds.length);
    assert.ok(store.list().every((task) => task.validator?.executable === process.execPath));
    assert.ok(
      store
        .list()
        .some(
          (task) => store.getRun(task.taskId)?.evidenceSummary === "validator failed [REDACTED]",
        ),
    );
    assert.doesNotMatch(terminal.writes.join(""), /fixture-secret/u);
    store.close();
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function readWorkspaceFile(workspace: string, fileName: string): Promise<string> {
  return readFile(path.join(workspace, fileName), "utf8");
}

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("interactive TUI selects each explicit model and persists the canonical id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-models-"));
  const terminal = new FakeTerminal();
  const observed: string[] = [];
  const cases = [
    ["deepseek-flash", "deepseek-v4-flash"],
    ["deepseek-pro", "deepseek-v4-pro"],
    ["minimax-m3", "MiniMax-M3"],
  ] as const;
  try {
    const runPromise = new InteractiveTui({
      appDataRoot: root,
      terminal,
      engine: {
        async *runTurn(input) {
          observed.push(input.model);
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "assistant.delta", taskId: input.taskId, text: `model ${input.model}` };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const [alias, model] of cases) {
      terminal.emitInput(":new");
      terminal.emitInput("\r");
      await waitForOutput(terminal, /new task ready/u);
      terminal.emitInput(`:model ${alias}`);
      terminal.emitInput("\r");
      await waitForOutput(terminal, new RegExp(`model selected: ${model}`, "u"));
      terminal.emitInput(`run ${alias}`);
      terminal.emitInput("\r");
      await waitForOutput(terminal, new RegExp(`model ${model}`, "u"));
    }
    const store = new SQLiteTaskStore(path.join(resolveAppPaths(root).state, "tasks.sqlite"));
    assert.deepEqual(
      observed,
      cases.map(([, model]) => model),
    );
    assert.deepEqual(
      store
        .list()
        .map((task) => task.model)
        .sort(),
      cases.map(([, model]) => model).sort(),
    );
    store.close();
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI rejects a model switch during an active turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-model-active-"));
  const terminal = new FakeTerminal();
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const runPromise = new InteractiveTui({
      appDataRoot: root,
      terminal,
      engine: {
        async *runTurn(input) {
          yield { type: "turn.started", taskId: input.taskId };
          await started;
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(":model deepseek-flash");
    terminal.emitInput("\r");
    terminal.emitInput("long model turn");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /long model turn/u);
    terminal.emitInput(":model minimax-m3");
    terminal.emitInput("\r");
    const output = await waitForOutput(terminal, /model switch rejected:.*active turn/u);
    assert.match(output, /model switch rejected/u);
    release?.();
    await waitForOutput(terminal, /completed/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    release?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI sends Candy-owned image attachments and recovers them after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-attachments-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-tui-attachment-workspace-"));
  const imagePath = path.join(path.dirname(root), "candy-tui-attachment-fixture.png");
  await writeFile(imagePath, VALID_PNG);
  const firstTerminal = new FakeTerminal();
  const firstImages: (readonly { readonly mimeType: string; readonly data: string }[])[] = [];
  let taskId: string | undefined;
  try {
    const firstRun = new InteractiveTui({
      appDataRoot: root,
      workspacePath: workspace,
      terminal: firstTerminal,
      engine: {
        async *runTurn(input) {
          firstImages.push(input.images ?? []);
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "assistant.delta", taskId: input.taskId, text: "image accepted" };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    firstTerminal.emitInput(`:attach ${imagePath}`);
    firstTerminal.emitInput("\r");
    await waitForOutput(firstTerminal, /attachment staged: att_[a-f0-9]{64}/u);
    firstTerminal.emitInput(":model minimax-m3");
    firstTerminal.emitInput("\r");
    await waitForOutput(firstTerminal, /model selected: MiniMax-M3/u);
    firstTerminal.emitInput(":new");
    firstTerminal.emitInput("\r");
    await waitForOutput(firstTerminal, /new task ready/u);
    firstTerminal.emitInput("describe the attached image");
    firstTerminal.emitInput("\r");
    const firstOutput = await waitForOutput(firstTerminal, /image accepted/u);
    taskId = [...firstOutput.matchAll(/created (task-[a-z0-9]+)/gu)].at(-1)?.[1];
    assert.ok(taskId);
    assert.equal(firstImages.length, 1);
    assert.equal(firstImages[0]?.[0]?.mimeType, "image/png");
    assert.equal(firstImages[0]?.[0]?.data, VALID_PNG.toString("base64"));
    const firstStore = new SQLiteTaskStore(path.join(resolveAppPaths(root).state, "tasks.sqlite"));
    const saved = firstStore.get(taskId);
    assert.ok(saved);
    assert.equal(saved.model, "MiniMax-M3");
    assert.equal(saved.attachmentIds.length, 1);
    const attachmentId = saved.attachmentIds[0];
    assert.ok(attachmentId);
    firstStore.close();
    firstTerminal.emitInput(":quit");
    firstTerminal.emitInput("\r");
    await firstRun;

    const secondTerminal = new FakeTerminal();
    const secondImages: (readonly { readonly mimeType: string; readonly data: string }[])[] = [];
    const secondRun = new InteractiveTui({
      appDataRoot: root,
      workspacePath: workspace,
      terminal: secondTerminal,
      engine: {
        async *runTurn(input) {
          secondImages.push(input.images ?? []);
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "assistant.delta", taskId: input.taskId, text: "recovered image" };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    secondTerminal.emitInput(`:use ${taskId}`);
    secondTerminal.emitInput("\r");
    await waitForOutput(secondTerminal, new RegExp(`current task: ${taskId}`, "u"));
    secondTerminal.emitInput(":attachments");
    secondTerminal.emitInput("\r");
    await waitForOutput(secondTerminal, new RegExp(`${attachmentId}\\timage/png`, "u"));
    secondTerminal.emitInput("continue with the saved image");
    secondTerminal.emitInput("\r");
    await waitForOutput(secondTerminal, /recovered image/u);
    assert.equal(secondImages.length, 1);
    assert.equal(secondImages[0]?.[0]?.data, VALID_PNG.toString("base64"));
    secondTerminal.emitInput(":quit");
    secondTerminal.emitInput("\r");
    await secondRun;
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(imagePath, { force: true });
  }
});

test("interactive TUI rejects unsafe or invalid attachment paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-attachment-reject-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-tui-attachment-reject-workspace-"));
  const outside = await mkdtemp(path.join(tmpdir(), "candy-tui-attachment-reject-outside-"));
  const terminal = new FakeTerminal();
  const workspaceImage = path.join(workspace, "workspace.png");
  const appDataImage = path.join(root, "app-data.png");
  const invalidMime = path.join(outside, "not-image.txt");
  const corruptImage = path.join(outside, "corrupt.png");
  const video = path.join(outside, "clip.mp4");
  const oversized = path.join(outside, "oversized.png");
  const linked = path.join(root, "linked.png");
  const linkTarget = path.join(outside, "target.png");
  await writeFile(workspaceImage, VALID_PNG);
  await writeFile(appDataImage, VALID_PNG);
  await writeFile(invalidMime, VALID_PNG);
  await writeFile(corruptImage, "not a png");
  await writeFile(video, "video");
  await writeFile(oversized, Buffer.alloc(10 * 1024 * 1024 + 1));
  await writeFile(linkTarget, VALID_PNG);
  try {
    await symlink(linkTarget, linked);
  } catch {
    // Windows test hosts may not grant symlink creation; the other path gates remain covered.
  }
  try {
    const runPromise = new InteractiveTui({
      appDataRoot: root,
      workspacePath: workspace,
      terminal,
      engine: {
        async *runTurn(input) {
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rejected = async (filePath: string, pattern: RegExp): Promise<void> => {
      terminal.emitInput(`:attach ${filePath}`);
      terminal.emitInput("\r");
      const output = await waitForOutput(terminal, pattern);
      assert.match(output, pattern);
    };
    await rejected(workspaceImage, /workspace attachment paths are not allowed/iu);
    await rejected(appDataImage, /Candy application-data attachment paths are not allowed/iu);
    await rejected(invalidMime, /unsupported image MIME type/iu);
    await rejected(corruptImage, /image content is corrupt/iu);
    await rejected(video, /video attachments are unavailable/iu);
    await rejected(oversized, /attachment exceeds the 10485760-byte limit/iu);
    if (await readFile(linked).catch(() => undefined))
      await rejected(linked, /symbolic links are not allowed/iu);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
