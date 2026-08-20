import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppServerController } from "../apps/app-server/dist/main.js";

if (process.platform !== "win32") {
  console.log("Windows cross-client smoke skipped: not Windows");
  process.exit(0);
}

const root = await mkdtemp(path.join(os.tmpdir(), "candy-cross-client-windows-"));
const workspace = path.join(root, "workspace");
const databasePath = path.join(root, "state", "tasks.sqlite");
await mkdir(workspace);

function command(commandId, expectedRevision, value) {
  return {
    v: 1,
    kind: "command",
    commandId,
    taskId: "windows-cross-client",
    expectedRevision,
    command: value,
  };
}

let releaseTurn;
let resolveStarted;
const started = new Promise((resolve) => {
  resolveStarted = resolve;
});
let resolveCompleted;
const completed = new Promise((resolve) => {
  resolveCompleted = resolve;
});
const ownerEngine = {
  async *runTurn(input) {
    resolveStarted?.();
    await new Promise((resolve) => {
      releaseTurn = resolve;
    });
    yield { type: "turn.completed", taskId: input.taskId, at: Date.now() };
  },
};

const first = new AppServerController({
  databasePath,
  engine: ownerEngine,
  ownerId: "windows-client-1",
});
const second = new AppServerController({
  databasePath,
  ownerId: "windows-client-2",
});

try {
  const created = await first.dispatch(
    command("cross-create", 0, {
      type: "task.create",
      prompt: "Windows cross-client owner fixture",
      approvalProfile: "read-only",
      workspacePath: workspace,
      model: "deepseek-v4-flash",
      attachmentIds: [],
    }),
  );
  assert.equal(created.at(-1)?.kind, "event");
  const runningEvents = [];
  await first.dispatch(command("cross-run", 0, { type: "task.run" }), (message) => {
    runningEvents.push(message);
    if (
      message.kind === "event" &&
      message.event.type === "snapshot" &&
      message.event.snapshot.state === "completed"
    )
      resolveCompleted?.();
  });
  await started;

  const remoteCancel = await second.dispatch(
    command("cross-remote-cancel", 1, { type: "task.cancel" }),
  );
  const remoteSnapshot = remoteCancel.at(-1);
  assert.equal(remoteSnapshot?.kind, "event");
  if (remoteSnapshot?.kind === "event" && remoteSnapshot.event.type === "snapshot") {
    assert.equal(remoteSnapshot.event.snapshot.state, "running");
    assert.equal(remoteSnapshot.event.snapshot.ownerId, "windows-client-1");
  }
  const remoteRun = await second.dispatch(command("cross-remote-run", 1, { type: "task.run" }));
  const remoteRunSnapshot = remoteRun.at(-1);
  assert.equal(remoteRunSnapshot?.kind, "event");
  if (remoteRunSnapshot?.kind === "event" && remoteRunSnapshot.event.type === "snapshot") {
    assert.equal(remoteRunSnapshot.event.snapshot.state, "running");
    assert.equal(remoteRunSnapshot.event.snapshot.ownerId, "windows-client-1");
  }

  releaseTurn?.();
  await completed;
  assert.equal(
    runningEvents.some(
      (message) =>
        message.kind === "event" &&
        message.event.type === "snapshot" &&
        message.event.snapshot.state === "completed",
    ),
    true,
  );
  console.log("Windows cross-client smoke passed: non-owner read-only fencing");
} finally {
  first.close();
  second.close();
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
