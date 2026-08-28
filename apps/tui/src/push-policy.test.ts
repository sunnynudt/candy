import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAppPaths, SQLiteTaskStore } from "@candy/platform";
import { InteractiveTui, type InteractiveTuiOptions, type TuiAgentEngine } from "./main.js";
import { FakeTerminal } from "./pi-tui-surface.js";

const testWorkspace = path.join(tmpdir(), "candy-push-policy-workspace");

class HarnessTui extends InteractiveTui {
  public constructor(options: InteractiveTuiOptions = {}) {
    super({ workspacePath: testWorkspace, ...options });
  }
}

async function waitForOutput(
  terminal: FakeTerminal,
  pattern: RegExp,
  maxAttempts: number = 500,
): Promise<string> {
  for (let attempt: number = 0; attempt < maxAttempts; attempt += 1) {
    const output: string = terminal.writes.join("");
    if (pattern.test(output)) return output;
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 1);
    });
  }
  return terminal.writes.join("");
}

test("TUI /push allow persists the push policy on new tasks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-push-policy-allow-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    await mkdir(testWorkspace, { recursive: true });
    const runPromise = new HarnessTui({ appDataRoot: root, engine, terminal }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput("/push allow");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /push policy set to allow/u);
    terminal.emitInput("/new write a fixture");
    terminal.emitInput("\r");
    const created = await waitForOutput(terminal, /created (task-[a-z0-9]+)/u);
    const taskId = created.match(/created (task-[a-z0-9]+)/u)?.[1];
    assert.ok(taskId, "task id should be printed");
    const store = new SQLiteTaskStore(path.join(resolveAppPaths(root).state, "tasks.sqlite"));
    const task = store.get(taskId);
    assert.equal(task?.pushPolicy, "allow");
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(testWorkspace, { recursive: true, force: true });
  }
});

test("TUI /push defaults to deny and rejects unknown values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-push-policy-default-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    await mkdir(testWorkspace, { recursive: true });
    const runPromise = new HarnessTui({ appDataRoot: root, engine, terminal }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput("/push");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /push policy for new tasks: deny/u);
    terminal.emitInput("/push bogus");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /push rejected: use \/push allow or \/push deny/u);
    terminal.emitInput("/push allow");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /push policy set to allow/u);
    terminal.emitInput("/push deny");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /push policy set to deny/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(testWorkspace, { recursive: true, force: true });
  }
});
