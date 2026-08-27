import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { resolveAppPaths, SQLiteTaskStore } from "@candy/platform";
import { InteractiveTui, type InteractiveTuiOptions, type TuiAgentEngine } from "./main.js";
import { FakeTerminal } from "./pi-tui-surface.js";

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const testWorkspace = await mkdtemp(path.join(tmpdir(), "candy-tui-detach-workspace-"));

class TestInteractiveTui extends InteractiveTui {
  public constructor(options: InteractiveTuiOptions = {}) {
    super({ workspacePath: testWorkspace, ...options });
  }
}

after(async () => {
  await rm(testWorkspace, { recursive: true, force: true });
});

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

async function waitForCondition(
  condition: () => boolean,
  maxAttempts: number = 500,
): Promise<boolean> {
  for (let attempt: number = 0; attempt < maxAttempts; attempt += 1) {
    if (condition()) return true;
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 1);
    });
  }
  return condition();
}

test("interactive TUI auto-detaches stored image attachments when switching a completed task to a non-M3 model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-detach-on-model-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-tui-detach-on-model-workspace-"));
  const imagePath = path.join(path.dirname(root), "candy-tui-detach-on-model-fixture.png");
  await writeFile(imagePath, VALID_PNG);
  const terminal = new FakeTerminal();
  const turnImages: (readonly { readonly mimeType: string; readonly data: string }[])[] = [];
  let taskId: string | undefined;
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        turnImages.push(input.images ?? []);
        yield { type: "turn.started", taskId: input.taskId };
        yield {
          type: "assistant.delta",
          taskId: input.taskId,
          text: "image turn",
        };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const runPromise = new TestInteractiveTui({
      appDataRoot: root,
      workspacePath: workspace,
      terminal,
      engine,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(`/attach ${imagePath}`);
    terminal.emitInput("\r");
    await waitForOutput(terminal, /attachment staged: att_[a-f0-9]{64}/u);
    terminal.emitInput("/model minimax-m3");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /model selected: MiniMax-M3/u);
    terminal.emitInput(":new");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /new task ready/u);
    terminal.emitInput("describe the image");
    terminal.emitInput("\r");
    const firstOutput = await waitForOutput(terminal, /image turn/u);
    taskId = [...firstOutput.matchAll(/created (task-[a-z0-9]+)/gu)].at(-1)?.[1];
    assert.ok(taskId);
    assert.equal(turnImages.length, 1);
    assert.equal(turnImages[0]?.length, 1);
    await waitForOutput(terminal, new RegExp(`${taskId} completed`, "u"));

    const beforeSwitchStore = new SQLiteTaskStore(
      path.join(resolveAppPaths(root).state, "tasks.sqlite"),
    );
    const beforeSwitch = beforeSwitchStore.get(taskId);
    assert.ok(beforeSwitch);
    assert.equal(beforeSwitch.model, "MiniMax-M3");
    assert.equal(beforeSwitch.attachmentIds.length, 1);
    beforeSwitchStore.close();

    terminal.emitInput("/model deepseek-flash");
    terminal.emitInput("\r");
    const switchOutput = await waitForOutput(terminal, /model selected: deepseek-v4-flash for /u);
    assert.match(switchOutput, /model selected: deepseek-v4-flash for /u);
    assert.match(switchOutput, /image attachments detached: 1; only MiniMax M3 accepts images/u);

    const detachedStore = new SQLiteTaskStore(
      path.join(resolveAppPaths(root).state, "tasks.sqlite"),
    );
    const detachedTask = detachedStore.get(taskId);
    assert.ok(detachedTask);
    assert.equal(detachedTask.model, "deepseek-v4-flash");
    assert.deepEqual(detachedTask.attachmentIds, []);
    detachedStore.close();

    terminal.emitInput("follow up without the image");
    terminal.emitInput("\r");
    assert.equal(await waitForCondition(() => turnImages.length === 2), true);
    assert.equal(turnImages.length, 2);
    assert.deepEqual(turnImages[1], []);

    const store = new SQLiteTaskStore(path.join(resolveAppPaths(root).state, "tasks.sqlite"));
    const saved = store.get(taskId);
    assert.ok(saved);
    assert.equal(saved.model, "deepseek-v4-flash");
    assert.equal(saved.attachmentIds.length, 0);
    store.close();

    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(imagePath, { force: true });
  }
});

test("interactive TUI clears staged image attachments when switching to a non-M3 model before any task exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-detach-staged-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-tui-detach-staged-workspace-"));
  const imagePath = path.join(path.dirname(root), "candy-tui-detach-staged-fixture.png");
  await writeFile(imagePath, VALID_PNG);
  const terminal = new FakeTerminal();
  const turnImages: (readonly { readonly mimeType: string; readonly data: string }[])[] = [];
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        turnImages.push(input.images ?? []);
        yield { type: "turn.started", taskId: input.taskId };
        yield {
          type: "assistant.delta",
          taskId: input.taskId,
          text: "staged then detached",
        };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const runPromise = new TestInteractiveTui({
      appDataRoot: root,
      workspacePath: workspace,
      terminal,
      engine,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(`/attach ${imagePath}`);
    terminal.emitInput("\r");
    await waitForOutput(terminal, /attachment staged: att_[a-f0-9]{64}/u);
    terminal.emitInput("/model deepseek-flash");
    terminal.emitInput("\r");
    const switchOutput = await waitForOutput(
      terminal,
      /image attachments detached: 1; only MiniMax M3 accepts images/u,
    );
    assert.match(switchOutput, /model selected: deepseek-v4-flash/u);

    terminal.emitInput(":attachments");
    terminal.emitInput("\r");
    const attachmentList = await waitForOutput(terminal, /attachments: none/u);
    assert.match(attachmentList, /attachments: none/u);

    terminal.emitInput(":new");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /new task ready/u);
    terminal.emitInput("plain text follow up");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /staged then detached/u);
    assert.equal(turnImages.length, 1);
    assert.deepEqual(turnImages[0], []);

    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(imagePath, { force: true });
  }
});
