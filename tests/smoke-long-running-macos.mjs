import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppServerController } from "@candy/app-server";
import { LongRunningControlError } from "@candy/runtime";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log("macOS long-running smoke skipped: not macOS arm64");
  process.exit(0);
}

const root = await mkdtemp(path.join(tmpdir(), "candy-long-running-macos-"));
const workspace = path.join(root, "workspace");
await mkdir(workspace);
const messages = [];
const turnPrompts = [];
let firstTurn = true;
let validatorCalls = 0;
const controller = new AppServerController({
  ownerId: "macos-long-running-smoke",
  engine: {
    async *runTurn(input, signal) {
      turnPrompts.push(input.prompt);
      if (firstTurn) {
        firstTurn = false;
        throw new LongRunningControlError("approval_required");
      }
      if (signal.aborted) throw signal.reason;
      yield { type: "assistant.delta", text: input.prompt };
      yield { type: "turn.completed", taskId: input.taskId, at: Date.now() };
    },
  },
  activeSecrets: () => ["fixture-secret"],
  changeTracker: {
    async captureBaseline() {
      return undefined;
    },
    async inspect() {
      return {
        available: false,
        tracked: [],
        untracked: [],
        patchText: "",
        patchTruncated: false,
      };
    },
  },
  validatorRunner: {
    async run() {
      validatorCalls += 1;
      return {
        ok: validatorCalls === 2,
        fingerprint: `validator-${validatorCalls}-fixture-secret`,
        evidence: `${validatorCalls === 2 ? "validator-pass" : "validator-fail"} fixture-secret`,
        durationMs: 1,
      };
    },
  },
});

function command(commandId, expectedRevision, command) {
  return {
    v: 1,
    kind: "command",
    commandId,
    taskId: "macos-long-running-smoke",
    expectedRevision,
    command,
  };
}

function emit(message) {
  messages.push(message);
}

async function waitForSnapshot(predicate) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = messages.findLast(
      (message) =>
        message.kind === "event" &&
        message.event.type === "snapshot" &&
        predicate(message.event.snapshot),
    );
    if (found?.kind === "event" && found.event.type === "snapshot") return found.event.snapshot;
    if (Date.now() >= deadline) throw new Error("macOS long-running smoke timed out.");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
  }
}

try {
  await controller.dispatch(
    command("long-create", 0, {
      type: "task.create",
      prompt: "macOS long-running base outcome",
      approvalProfile: "auto",
      workspacePath: workspace,
      validator: { executable: process.execPath, args: ["-e", "process.exit(1)"] },
    }),
  );
  await controller.dispatch(command("long-run", 0, { type: "task.run" }), emit);
  const waiting = await waitForSnapshot((snapshot) => snapshot.state === "waiting_approval");
  assert.equal(waiting.progress?.stopReason, "approval_required");
  assert.match(waiting.approvalId ?? "", /^approval:macos-long-running-smoke:\d+$/u);

  await assert.rejects(
    controller.dispatch(
      command("long-stale-approval", waiting.revision, {
        type: "approval.respond",
        approvalId: "approval:stale",
        decision: "approve",
      }),
    ),
  );
  await controller.dispatch(
    command("long-steer", waiting.revision, { type: "task.steer", text: "steer-next-round" }),
  );
  const approvalResponses = await controller.dispatch(
    command("long-approve", waiting.revision, {
      type: "approval.respond",
      approvalId: waiting.approvalId,
      decision: "approve",
    }),
    emit,
  );
  const approved = approvalResponses.at(-1);
  assert.ok(approved?.kind === "event" && approved.event.type === "snapshot");
  if (approved?.kind === "event" && approved.event.type === "snapshot")
    assert.equal(approved.event.snapshot.state, "running");

  const completed = await waitForSnapshot((snapshot) => snapshot.state === "completed");
  assert.equal(validatorCalls, 2);
  assert.deepEqual(turnPrompts, [
    "macOS long-running base outcome",
    "steer-next-round",
    "macOS long-running base outcome",
  ]);
  assert.equal(completed.progress?.stopReason, "validator_succeeded");
  assert.equal(completed.progress?.evidenceSummary, "validator-pass [REDACTED]");
  assert.equal(JSON.stringify(messages).includes("fixture-secret"), false);
  console.log(
    `macOS long-running deterministic smoke passed: ${JSON.stringify({
      waitingApproval: true,
      steeringNextTurn: true,
      validatorCalls,
      completedBy: completed.progress?.stopReason,
      evidenceSummary: completed.progress?.evidenceSummary,
      uncertainActionReplay: false,
    })}`,
  );
} finally {
  controller.close();
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
