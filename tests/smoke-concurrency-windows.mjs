import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppServerController } from "../apps/app-server/dist/main.js";

if (process.platform !== "win32") {
  console.log("Windows concurrency smoke skipped: not Windows");
  process.exit(0);
}

const root = await mkdtemp(path.join(tmpdir(), "candy-concurrency-windows-"));
const workspace = path.join(root, "workspace");
await mkdir(workspace);
const startedOrder = [];
const gateResolvers = new Map();
const completed = new Set();
let active = 0;
let maximumActive = 0;
let resolveInitialStarted;
const initialStarted = new Promise((resolve) => {
  resolveInitialStarted = resolve;
});

const engine = {
  async *runTurn(input, signal) {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    startedOrder.push(input.taskId);
    if (startedOrder.length === 3) resolveInitialStarted?.();
    try {
      await new Promise((resolve, reject) => {
        const onAbort = () =>
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        gateResolvers.set(input.taskId, () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      yield { type: "turn.completed", taskId: input.taskId, at: Date.now() };
    } finally {
      active -= 1;
      gateResolvers.delete(input.taskId);
    }
  },
};

function command(taskId, commandId, expectedRevision, value) {
  return {
    v: 1,
    kind: "command",
    commandId,
    taskId,
    expectedRevision,
    command: value,
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
  throw new Error(message);
}

const controller = new AppServerController({ engine });
try {
  for (let index = 1; index <= 4; index += 1) {
    const taskId = `windows-concurrency-${index}`;
    await controller.dispatch(
      command(taskId, `create-${index}`, 0, {
        type: "task.create",
        prompt: taskId,
        approvalProfile: "read-only",
        workspacePath: workspace,
        model: "deepseek-v4-flash",
        attachmentIds: [],
      }),
    );
    await controller.dispatch(
      command(taskId, `run-${index}`, 0, { type: "task.run" }),
      (message) => {
        if (
          message.kind === "event" &&
          message.event.type === "snapshot" &&
          message.event.snapshot.state === "completed"
        )
          completed.add(taskId);
      },
    );
  }

  await initialStarted;
  const queued = await controller.dispatch(
    command("windows-concurrency-4", "snapshot-4", 0, { type: "snapshot" }),
  );
  const queuedSnapshot = queued.at(-1);
  assert.equal(queuedSnapshot?.kind, "event");
  if (queuedSnapshot?.kind === "event" && queuedSnapshot.event.type === "snapshot") {
    assert.equal(queuedSnapshot.event.snapshot.state, "queued");
    assert.equal(queuedSnapshot.event.snapshot.revision, 0);
  }
  assert.equal(startedOrder.includes("windows-concurrency-4"), false);

  gateResolvers.get("windows-concurrency-1")?.();
  await waitFor(
    () => startedOrder.includes("windows-concurrency-4"),
    "Windows fourth task was not promoted after a slot was released.",
  );
  for (const release of gateResolvers.values()) release();
  await waitFor(() => completed.size === 4, "Windows concurrency tasks did not all complete.");
  assert.deepEqual(startedOrder.slice(0, 4), [
    "windows-concurrency-1",
    "windows-concurrency-2",
    "windows-concurrency-3",
    "windows-concurrency-4",
  ]);
  assert.equal(maximumActive <= 3, true);
  console.log(
    "Windows concurrency smoke passed: three active slots, FIFO promotion, and completion",
  );
} finally {
  controller.close();
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
