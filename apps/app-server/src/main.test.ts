import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PiAgentEngineInput } from "@candy/pi-adapter";
import { type CommandEnvelope, type EventEnvelope, type ProtocolMessage } from "@candy/protocol";
import { DEFAULT_CANDY_MODEL, SQLiteTaskStore } from "@candy/platform";
import { ProviderContractError } from "@candy/pi-adapter";
import {
  AttachmentStore,
  LongRunningControlError,
  type AgentEngine,
  type AgentTurnInput,
  type ApplyChangesInput,
  type RecoverableAgentEngine,
} from "@candy/runtime";
import { AppServerController, PiAppServerEngine } from "./main.js";

function command(
  taskId: string,
  commandId: string,
  expectedRevision: number,
  value: CommandEnvelope["command"],
): CommandEnvelope {
  return { v: 1, kind: "command", commandId, taskId, expectedRevision, command: value };
}

function eventTypes(messages: readonly ProtocolMessage[]): string[] {
  return messages.flatMap((message) => (message.kind === "event" ? [message.event.type] : []));
}

type SnapshotEnvelope = Omit<EventEnvelope, "event"> & {
  readonly event: Extract<EventEnvelope["event"], { readonly type: "snapshot" }>;
};

async function waitForCompletion(
  background: readonly ProtocolMessage[],
  taskId: string,
): Promise<void> {
  for (
    let attempt = 0;
    attempt < 200 &&
    !background.some(
      (message) =>
        message.kind === "event" &&
        message.event.type === "snapshot" &&
        message.event.snapshot.taskId === taskId &&
        message.event.snapshot.state === "completed",
    );
    attempt += 1
  )
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

async function waitForSnapshotState(
  background: readonly ProtocolMessage[],
  taskId: string,
  state: string,
): Promise<SnapshotEnvelope> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = background.findLast(
      (message) =>
        message.kind === "event" &&
        message.event.type === "snapshot" &&
        message.event.snapshot.taskId === taskId &&
        message.event.snapshot.state === state,
    );
    if (found?.kind === "event" && found.event.type === "snapshot")
      return found as SnapshotEnvelope;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Task ${taskId} did not reach ${state}.`);
}

function createGitFixture(root: string): { readonly repository: string; readonly base: string } {
  const repository = path.join(root, "repo");
  mkdirSync(repository);
  const git = (args: readonly string[], cwd: string): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"], repository);
  writeFileSync(path.join(repository, "README.md"), "base\n");
  git(["add", "README.md"], repository);
  git(
    [
      "-c",
      "user.name=Candy Fixture",
      "-c",
      "user.email=candy-fixture@example.invalid",
      "commit",
      "-qm",
      "base",
    ],
    repository,
  );
  return { repository, base: git(["rev-parse", "HEAD"], repository).trim() };
}

function worktreeEditingEngine(): AgentEngine {
  return {
    async *runTurn(input: AgentTurnInput) {
      if (input.cwd !== undefined) {
        await writeFile(path.join(input.cwd, "README.md"), "changed by task\n");
        await writeFile(path.join(input.cwd, "new.txt"), "untracked by task\n");
      }
      yield { type: "turn.completed", taskId: input.taskId, at: Date.now() };
    },
  };
}

test("app-server creates, runs, streams and durably completes one task", async () => {
  const controller = new AppServerController({
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
  });
  const background: ProtocolMessage[] = [];
  try {
    const created = await controller.dispatch(
      command("task-1", "create-1", 0, {
        type: "task.create",
        prompt: "inspect fixture",
        approvalProfile: "read-only",
        workspacePath: process.cwd(),
      }),
    );
    assert.deepEqual(eventTypes(created), ["task.created", "snapshot"]);

    const started = await controller.dispatch(
      command("task-1", "run-1", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    assert.deepEqual(eventTypes(started), ["task.state_changed", "snapshot"]);
    for (
      let attempt = 0;
      attempt < 20 &&
      !background.some(
        (message) =>
          message.kind === "event" &&
          message.event.type === "snapshot" &&
          message.event.snapshot.state === "completed",
      );
      attempt += 1
    )
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(eventTypes(background), [
      "assistant.delta",
      "workspace.changes",
      "task.state_changed",
      "snapshot",
    ]);
    const last = background.at(-1);
    assert.ok(last?.kind === "event");
    assert.equal(last.event.type, "snapshot");
    if (last.event.type === "snapshot") assert.equal(last.event.snapshot.state, "completed");

    await assert.rejects(
      controller.dispatch(command("task-1", "stale", 0, { type: "task.cancel" })),
      /current revision/u,
    );
  } finally {
    controller.close();
  }
});

test("app-server exposes Personal Preview Shell only in a Task Worktree and waits for approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-app-server-shell-"));
  const { repository, base } = createGitFixture(root);
  const worktreeRoot = path.join(root, "worktrees");
  const calls: unknown[] = [];
  const background: ProtocolMessage[] = [];
  const controller = new AppServerController({
    worktreeRoot,
    bashRunner: {
      run: async (request) => {
        calls.push(request);
        return { code: 0, signal: null, stdout: "ok\n", stderr: "", cancelled: false };
      },
    },
    engine: {
      async *runTurn(input: AgentTurnInput) {
        if (!input.trustedShell || input.shellApproval === undefined)
          throw new Error("shell missing");
        yield { type: "tool.started" as const, taskId: input.taskId, tool: "candy_bash" };
        const approved = await input.shellApproval(
          { command: "git status --short", cwd: input.cwd! },
          new AbortController().signal,
        );
        if (!approved) throw new Error("denied");
        yield {
          type: "tool.completed" as const,
          taskId: input.taskId,
          tool: "candy_bash",
          ok: true,
        };
        yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
      },
    },
  });
  try {
    const created = await controller.dispatch(
      command("shell-task", "create", 0, {
        type: "task.create",
        prompt: "inspect",
        approvalProfile: "auto",
        trustedShell: true,
        workspacePath: repository,
      }),
    );
    const createdSnapshot = created.find(
      (message) => message.kind === "event" && message.event.type === "snapshot",
    );
    assert.equal(createdSnapshot?.kind, "event");
    if (createdSnapshot?.kind !== "event" || createdSnapshot.event.type !== "snapshot")
      throw new Error("missing snapshot");
    assert.equal(createdSnapshot.event.snapshot.trustedShell, true);
    await controller.dispatch(command("shell-task", "run", 0, { type: "task.run" }), (message) =>
      background.push(message),
    );
    const waiting = await waitForSnapshotState(background, "shell-task", "waiting_approval");
    assert.equal(waiting.event.snapshot.shellApproval?.command, "git status --short");
    await controller.dispatch(
      command("shell-task", "approve", waiting.revision, {
        type: "approval.respond",
        approvalId: waiting.event.snapshot.approvalId!,
        decision: "approve",
      }),
      (message) => background.push(message),
    );
    await waitForSnapshotState(background, "shell-task", "completed");
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(base.length > 0, true);
  assert.equal(calls.length, 0);
});

test("app-server rejects Personal Preview Shell before creating a Worktree for non-Git workspaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-app-server-shell-nongit-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const worktreeRoot = path.join(root, "worktrees");
  const controller = new AppServerController({
    worktreeRoot,
    bashRunner: {
      run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", cancelled: false }),
    },
  });
  try {
    await assert.rejects(
      controller.dispatch(
        command("shell-nongit", "create", 0, {
          type: "task.create",
          prompt: "inspect",
          approvalProfile: "auto",
          trustedShell: true,
          workspacePath: workspace,
        }),
      ),
      /Git Task Worktree/iu,
    );
    assert.equal(existsSync(worktreeRoot), false);
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app-server cancels a pending Personal Preview Shell approval without replay", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-app-server-shell-cancel-"));
  const { repository } = createGitFixture(root);
  const background: ProtocolMessage[] = [];
  const controller = new AppServerController({
    worktreeRoot: path.join(root, "worktrees"),
    engine: {
      async *runTurn(input: AgentTurnInput, signal) {
        if (!input.shellApproval) throw new Error("shell missing");
        await input.shellApproval({ command: "git status --short", cwd: input.cwd! }, signal);
        yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
      },
    },
    bashRunner: {
      run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", cancelled: false }),
    },
  });
  try {
    await controller.dispatch(
      command("shell-cancel", "create", 0, {
        type: "task.create",
        prompt: "inspect",
        approvalProfile: "auto",
        trustedShell: true,
        workspacePath: repository,
      }),
    );
    await controller.dispatch(command("shell-cancel", "run", 0, { type: "task.run" }), (message) =>
      background.push(message),
    );
    const waiting = await waitForSnapshotState(background, "shell-cancel", "waiting_approval");
    const cancelled = await controller.dispatch(
      command("shell-cancel", "cancel", waiting.revision, { type: "task.cancel" }),
      (message) => background.push(message),
    );
    const snapshot = cancelled.at(-1);
    assert.ok(snapshot?.kind === "event" && snapshot.event.type === "snapshot");
    if (snapshot?.kind === "event" && snapshot.event.type === "snapshot") {
      assert.equal(snapshot.event.snapshot.state, "cancelled");
      assert.equal(snapshot.event.snapshot.shellApproval, undefined);
    }
    assert.equal(
      background.filter(
        (message) =>
          message.kind === "event" &&
          message.event.type === "snapshot" &&
          message.event.snapshot.state === "waiting_approval",
      ).length,
      1,
    );
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app-server runs a task in its selected workspace instead of the child cwd", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-selected-workspace-"));
  const received: string[] = [];
  const engine = {
    async *runTurn(input: AgentTurnInput) {
      received.push(input.cwd ?? "");
      yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
    },
  };
  const controller = new AppServerController({
    engine,
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
  });
  try {
    await controller.dispatch(
      command("task-workspace", "create-workspace", 0, {
        type: "task.create",
        prompt: "inspect workspace",
        approvalProfile: "read-only",
        workspacePath: workspace,
      }),
    );
    await controller.dispatch(command("task-workspace", "run-workspace", 0, { type: "task.run" }));
    for (let attempt = 0; attempt < 10 && received.length === 0; attempt += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [workspace]);
  } finally {
    controller.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("app-server persists a task transcript across controller restart", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-transcript-restart-"));
  const directory = await mkdtemp(path.join(tmpdir(), "candy-transcript-store-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  const options = {
    engine: {
      async *runTurn(input: AgentTurnInput) {
        yield { type: "assistant.delta" as const, text: "inspecting the fixture" };
        yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
      },
    },
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
  } as const;
  try {
    const first = new AppServerController({ ...options, databasePath });
    await first.dispatch(
      command("task-transcript-restart", "create-transcript", 0, {
        type: "task.create",
        prompt: "fix the failing test",
        approvalProfile: "read-only",
        workspacePath: workspace,
      }),
    );
    const events: ProtocolMessage[] = [];
    await first.dispatch(
      command("task-transcript-restart", "run-transcript", 0, { type: "task.run" }),
      (message) => events.push(message),
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const completed = events.some(
        (message) =>
          message.kind === "event" &&
          message.event.type === "snapshot" &&
          message.event.snapshot.state === "completed",
      );
      if (completed) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    first.close();

    const second = new AppServerController({ ...options, databasePath });
    const restoredMessages = await second.dispatch(
      command("task-transcript-restart", "snapshot-transcript", 2, { type: "snapshot" }),
    );
    const snapshotMessage = restoredMessages.find(
      (message): message is SnapshotEnvelope =>
        message.kind === "event" && message.event.type === "snapshot",
    );
    if (snapshotMessage === undefined) throw new Error("Snapshot unavailable after restart.");
    assert.equal(snapshotMessage.event.snapshot.state, "completed");
    assert.deepEqual(snapshotMessage.event.snapshot.transcript, [
      { role: "user", text: "fix the failing test" },
      { role: "assistant", text: "inspecting the fixture" },
    ]);
    second.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("app-server runs an explicit validator before marking edited work complete", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-validator-workspace-"));
  const validatorCalls: string[] = [];
  const controller = new AppServerController({
    engine: {
      async *runTurn(input: AgentTurnInput) {
        yield {
          type: "tool.completed" as const,
          taskId: input.taskId,
          tool: "candy_edit",
          ok: true,
        };
        yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
      },
    },
    validatorRunner: {
      async run(command, cwd) {
        validatorCalls.push(`${command.executable}:${cwd}`);
        return { ok: true };
      },
    },
  });
  const background: ProtocolMessage[] = [];
  try {
    await controller.dispatch(
      command("task-validator", "create-validator", 0, {
        type: "task.create",
        prompt: "edit then test",
        approvalProfile: "auto",
        workspacePath: workspace,
        validator: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
      }),
    );
    await controller.dispatch(
      command("task-validator", "run-validator", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    await waitForCompletion(background, "task-validator");
    assert.deepEqual(validatorCalls, [`${process.execPath}:${workspace}`]);
    assert.deepEqual(
      background
        .filter((message) => message.kind === "event" && message.event.type.startsWith("tool."))
        .map((message) =>
          message.kind === "event" && message.event.type === "tool.started"
            ? "started"
            : "completed",
        ),
      ["completed", "started", "completed"],
    );
  } finally {
    controller.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("app-server runs auto validator tasks through normal turns and persists bounded progress", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-long-running-workspace-"));
  let turns = 0;
  let validatorCalls = 0;
  const background: ProtocolMessage[] = [];
  const controller = new AppServerController({
    engine: {
      async *runTurn(input: AgentTurnInput) {
        turns += 1;
        yield { type: "assistant.delta" as const, text: `round-${turns}` };
        yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
      },
    },
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
          fingerprint: `validator-${validatorCalls}`,
          evidence: `attempt-${validatorCalls}`,
          durationMs: 1,
        };
      },
    },
  });
  try {
    await controller.dispatch(
      command("task-long-running", "create-long-running", 0, {
        type: "task.create",
        prompt: "repair until validator passes",
        approvalProfile: "auto",
        workspacePath: workspace,
        validator: { executable: process.execPath, args: ["-e", "process.exit(1)"] },
      }),
    );
    await controller.dispatch(
      command("task-long-running", "run-long-running", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    await waitForCompletion(background, "task-long-running");

    const completed = background.findLast(
      (message) =>
        message.kind === "event" &&
        message.event.type === "snapshot" &&
        message.event.snapshot.state === "completed",
    );
    assert.ok(completed?.kind === "event" && completed.event.type === "snapshot");
    if (completed?.kind === "event" && completed.event.type === "snapshot") {
      const progress = completed.event.snapshot.progress;
      assert.ok(progress);
      assert.match(progress.lastFingerprintHash ?? "", /^[a-f0-9]{64}$/u);
      assert.deepEqual(progress, {
        rounds: 2,
        evidenceCount: 2,
        completed: true,
        stopReason: "validator_succeeded",
        lastFingerprintHash: progress.lastFingerprintHash,
        evidenceSummary: "attempt-2",
      });
    }
    assert.equal(turns, 2);
    assert.equal(validatorCalls, 2);
  } finally {
    controller.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("app-server pauses for approval, applies steering to a new turn, and projects redacted final evidence", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-long-running-approval-"));
  const prompts: string[] = [];
  let firstTurn = true;
  let validatorCalls = 0;
  const background: ProtocolMessage[] = [];
  const controller = new AppServerController({
    engine: {
      async *runTurn(input: AgentTurnInput, signal: AbortSignal) {
        prompts.push(input.prompt);
        if (firstTurn) {
          firstTurn = false;
          throw new LongRunningControlError("approval_required");
        }
        if (signal.aborted) throw signal.reason;
        yield { type: "assistant.delta" as const, text: input.prompt };
        yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
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
  try {
    await controller.dispatch(
      command("task-approval-steer", "approval-create", 0, {
        type: "task.create",
        prompt: "base outcome",
        approvalProfile: "auto",
        workspacePath: workspace,
        validator: { executable: process.execPath, args: ["-e", "process.exit(1)"] },
      }),
    );
    await controller.dispatch(
      command("task-approval-steer", "approval-run", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    const waiting = await waitForSnapshotState(
      background,
      "task-approval-steer",
      "waiting_approval",
    );
    assert.equal(waiting.event.snapshot.progress?.stopReason, "approval_required");
    assert.equal(waiting.event.snapshot.approvalId, "approval:task-approval-steer:2");

    await controller.dispatch(
      command("task-approval-steer", "approval-steer", 2, {
        type: "task.steer",
        text: "steer-next-round",
      }),
    );
    const approved = await controller.dispatch(
      command("task-approval-steer", "approval-approve", 2, {
        type: "approval.respond",
        approvalId: waiting.event.snapshot.approvalId,
        decision: "approve",
      }),
      (message) => background.push(message),
    );
    const approvalSnapshot = approved.at(-1);
    assert.ok(approvalSnapshot?.kind === "event" && approvalSnapshot.event.type === "snapshot");
    if (approvalSnapshot?.kind === "event" && approvalSnapshot.event.type === "snapshot")
      assert.equal(approvalSnapshot.event.snapshot.state, "running");

    await waitForCompletion(background, "task-approval-steer");
    const completed = await waitForSnapshotState(background, "task-approval-steer", "completed");
    assert.equal(validatorCalls, 2);
    assert.deepEqual(prompts, ["base outcome", "steer-next-round", "base outcome"]);
    assert.equal(completed.event.snapshot.progress?.stopReason, "validator_succeeded");
    assert.equal(completed.event.snapshot.progress?.evidenceSummary, "validator-pass [REDACTED]");
    assert.equal(JSON.stringify(background).includes("fixture-secret"), false);
  } finally {
    controller.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("app-server persists a paused long-running task and resumes it explicitly after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-long-running-restart-"));
  const workspace = path.join(root, "workspace");
  const databasePath = path.join(root, "state", "tasks.sqlite");
  mkdirSync(workspace);
  let firstTurnStarted: (() => void) | undefined;
  let firstTurnStopped: (() => void) | undefined;
  let resumed = false;
  const first = new AppServerController({
    engine: {
      async *runTurn(input: AgentTurnInput, signal: AbortSignal) {
        firstTurnStarted?.();
        await new Promise<void>((resolve) => {
          firstTurnStopped = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (signal.aborted) throw signal.reason;
        yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
      },
      async recoverPrompt() {
        return "recovered long-running prompt";
      },
    } satisfies RecoverableAgentEngine,
    databasePath,
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
        return { ok: true, fingerprint: "recovered-pass", evidence: "ok", durationMs: 1 };
      },
    },
  });
  const firstEvents: ProtocolMessage[] = [];
  const started = new Promise<void>((resolve) => {
    firstTurnStarted = resolve;
  });
  try {
    await first.dispatch(
      command("task-long-restart", "create-long-restart", 0, {
        type: "task.create",
        prompt: "pause and resume",
        approvalProfile: "auto",
        workspacePath: workspace,
        validator: { executable: process.execPath, args: ["-e", "process.exit(0)"] },
      }),
    );
    await first.dispatch(
      command("task-long-restart", "run-long-restart", 0, { type: "task.run" }),
      (message) => firstEvents.push(message),
    );
    await started;
    const paused = await first.dispatch(
      command("task-long-restart", "pause-long-restart", 1, { type: "task.pause" }),
    );
    firstTurnStopped?.();
    const pausedSnapshot = paused.at(-1);
    assert.ok(pausedSnapshot?.kind === "event" && pausedSnapshot.event.type === "snapshot");
    if (pausedSnapshot?.kind === "event" && pausedSnapshot.event.type === "snapshot") {
      assert.equal(pausedSnapshot.event.snapshot.state, "paused");
      assert.equal(pausedSnapshot.event.snapshot.progress?.stopReason, "user_stop");
    }
  } finally {
    first.close();
  }

  const secondEvents: ProtocolMessage[] = [];
  const second = new AppServerController({
    engine: {
      async *runTurn(input: AgentTurnInput) {
        resumed = true;
        yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
      },
      async recoverPrompt() {
        return "recovered long-running prompt";
      },
    } satisfies RecoverableAgentEngine,
    databasePath,
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
        return { ok: true, fingerprint: "recovered-pass", evidence: "ok", durationMs: 1 };
      },
    },
  });
  try {
    const beforeResume = await second.dispatch(
      command("task-long-restart", "snapshot-long-restart", 2, { type: "snapshot" }),
    );
    const beforeSnapshot = beforeResume.at(-1);
    assert.ok(beforeSnapshot?.kind === "event" && beforeSnapshot.event.type === "snapshot");
    if (beforeSnapshot?.kind === "event" && beforeSnapshot.event.type === "snapshot") {
      assert.equal(beforeSnapshot.event.snapshot.state, "paused");
      assert.equal(beforeSnapshot.event.snapshot.progress?.stopReason, "user_stop");
    }
    await second.dispatch(
      command("task-long-restart", "resume-long-restart", 2, { type: "task.resume" }),
      (message) => secondEvents.push(message),
    );
    await waitForCompletion(secondEvents, "task-long-restart");
    assert.equal(resumed, true);
  } finally {
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app-server marks an uncertain active run as crash-interrupted before explicit resume", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-crash-recovery-"));
  const workspace = path.join(root, "workspace");
  const databasePath = path.join(root, "state", "tasks.sqlite");
  mkdirSync(workspace);
  const seed = new SQLiteTaskStore(databasePath);
  seed.create("task-crash-recovery", "auto", 1, DEFAULT_CANDY_MODEL, [], workspace, {
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
  });
  seed.transition("task-crash-recovery", 0, "running", "old-app-server");
  seed.recordRun({
    taskId: "task-crash-recovery",
    rounds: 1,
    evidenceCount: 1,
    completed: false,
    stopReason: "running",
  });
  seed.close();

  let resumed = false;
  const controller = new AppServerController({
    databasePath,
    engine: {
      async *runTurn(input: AgentTurnInput) {
        resumed = true;
        yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
      },
      async recoverPrompt() {
        return "resume after crash";
      },
    } satisfies RecoverableAgentEngine,
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
        return { ok: true, fingerprint: "crash-recovered", evidence: "ok", durationMs: 1 };
      },
    },
  });
  const background: ProtocolMessage[] = [];
  try {
    const interrupted = await controller.dispatch(
      command("task-crash-recovery", "snapshot-crash-recovery", 2, { type: "snapshot" }),
    );
    const interruptedSnapshot = interrupted.at(-1);
    assert.ok(
      interruptedSnapshot?.kind === "event" && interruptedSnapshot.event.type === "snapshot",
    );
    if (interruptedSnapshot?.kind === "event" && interruptedSnapshot.event.type === "snapshot") {
      assert.equal(interruptedSnapshot.event.snapshot.state, "interrupted");
      assert.equal(interruptedSnapshot.event.snapshot.progress?.stopReason, "crash_interrupted");
      assert.equal(interruptedSnapshot.event.snapshot.progress?.rounds, 1);
    }
    await controller.dispatch(
      command("task-crash-recovery", "resume-crash-recovery", 2, { type: "task.resume" }),
      (message) => background.push(message),
    );
    await waitForCompletion(background, "task-crash-recovery");
    assert.equal(resumed, true);
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app-server publishes the reviewed workspace changes before task completion", async () => {
  const observed: Array<{ readonly workspace: string; readonly baseCommit?: string }> = [];
  const controller = new AppServerController({
    engine: {
      async *runTurn(input: AgentTurnInput) {
        yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
      },
    },
    changeTracker: {
      async captureBaseline(workspace: string) {
        observed.push({ workspace });
        return "0123456789abcdef";
      },
      async inspect(workspace: string, baseCommit?: string) {
        observed.push(baseCommit === undefined ? { workspace } : { workspace, baseCommit });
        return {
          available: true,
          tracked: ["src/value.ts"],
          untracked: ["notes.txt"],
          patchText: "diff --git a/src/value.ts b/src/value.ts\nfixture-secret\n",
          patchTruncated: false,
        };
      },
    },
    activeSecrets: () => ["fixture-secret"],
  });
  const background: ProtocolMessage[] = [];
  try {
    await controller.dispatch(
      command("task-changes", "create-changes", 0, {
        type: "task.create",
        prompt: "edit fixture",
        approvalProfile: "read-only",
        workspacePath: process.cwd(),
      }),
    );
    await controller.dispatch(
      command("task-changes", "run-changes", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    for (
      let attempt = 0;
      attempt < 20 &&
      !background.some(
        (message) =>
          message.kind === "event" &&
          message.event.type === "snapshot" &&
          message.event.snapshot.state === "completed",
      );
      attempt += 1
    )
      await new Promise<void>((resolve) => setImmediate(resolve));

    const changes = background.find(
      (message) => message.kind === "event" && message.event.type === "workspace.changes",
    );
    assert.ok(changes?.kind === "event" && changes.event.type === "workspace.changes");
    if (changes?.kind === "event" && changes.event.type === "workspace.changes") {
      assert.deepEqual(changes.event.tracked, ["src/value.ts"]);
      assert.deepEqual(changes.event.untracked, ["notes.txt"]);
      assert.match(changes.event.patchText, /^diff --git/u);
      assert.equal(changes.event.patchText.includes("fixture-secret"), false);
      assert.equal(changes.event.patchTruncated, false);
    }
    assert.deepEqual(observed, [
      { workspace: process.cwd() },
      { workspace: process.cwd(), baseCommit: "0123456789abcdef" },
    ]);
  } finally {
    controller.close();
  }
});

test("app-server reviews added, changed, and removed files in a non-Git workspace", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-nongit-journey-"));
  await writeFile(path.join(workspace, "README.md"), "base\n");
  await writeFile(path.join(workspace, "old.txt"), "base\n");
  const engine = {
    async *runTurn(input: AgentTurnInput) {
      if (input.cwd !== undefined) {
        await writeFile(path.join(input.cwd, "README.md"), "changed\n");
        await writeFile(path.join(input.cwd, "new.txt"), "new\n");
        await rm(path.join(input.cwd, "old.txt"));
      }
      yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
    },
  };
  const controller = new AppServerController({ engine });
  try {
    await controller.dispatch(
      command("task-nongit", "create-nongit", 0, {
        type: "task.create",
        prompt: "review non-Git workspace",
        approvalProfile: "read-only",
        workspacePath: workspace,
      }),
    );
    const background: ProtocolMessage[] = [];
    await controller.dispatch(
      command("task-nongit", "run-nongit", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    await waitForCompletion(background, "task-nongit");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const changes = background.find(
      (message): message is Extract<ProtocolMessage, { readonly kind: "event" }> =>
        message.kind === "event" && message.event.type === "workspace.changes",
    );
    if (changes === undefined || changes.event.type !== "workspace.changes")
      throw new Error(
        `Non-Git workspace changes were not published: ${background
          .map((message) => (message.kind === "event" ? message.event.type : message.kind))
          .join(",")}`,
      );
    assert.equal(changes.event.available, true);
    assert.deepEqual(changes.event.tracked, ["README.md", "new.txt", "old.txt"]);
  } finally {
    controller.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("app-server applies reviewed changes through the reviewed command seam", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-app-server-apply-"));
  const applyCalls: Array<{
    readonly sourceRoot: string;
    readonly input: ApplyChangesInput;
  }> = [];
  const controller = new AppServerController({
    engine: {
      async *runTurn(input: AgentTurnInput) {
        yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
      },
    },
    changeTracker: {
      async captureBaseline() {
        return "0123456789abcdef";
      },
      async inspect() {
        return {
          available: true,
          tracked: ["src/value.ts"],
          untracked: ["new.txt"],
          patchText: "diff --git a/src/value.ts b/src/value.ts\n",
          patchTruncated: false,
        };
      },
    },
    applyChanges: {
      async apply(sourceRoot: string, input: ApplyChangesInput) {
        applyCalls.push({ sourceRoot, input });
        return "applied";
      },
    },
  });
  const background: ProtocolMessage[] = [];
  try {
    await controller.dispatch(
      command("task-apply", "create-apply", 0, {
        type: "task.create",
        prompt: "review then apply",
        approvalProfile: "read-only",
        workspacePath: workspace,
      }),
    );
    await assert.rejects(
      controller.dispatch(
        command("task-apply", "apply-early", 0, {
          type: "workspace.apply",
          expectedBase: "0123456789abcdef",
          tracked: ["src/value.ts"],
          untracked: ["new.txt"],
        }),
      ),
      /completed task/u,
    );
    await controller.dispatch(
      command("task-apply", "run-apply", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    for (
      let attempt = 0;
      attempt < 20 &&
      !background.some(
        (message) =>
          message.kind === "event" &&
          message.event.type === "snapshot" &&
          message.event.snapshot.state === "completed",
      );
      attempt += 1
    )
      await new Promise<void>((resolve) => setImmediate(resolve));
    const responses = await controller.dispatch(
      command("task-apply", "apply-1", 2, {
        type: "workspace.apply",
        expectedBase: "0123456789abcdef",
        tracked: ["src/value.ts"],
        untracked: ["new.txt"],
      }),
    );
    const snapshot = responses.at(-1);
    assert.ok(snapshot?.kind === "event" && snapshot.event.type === "snapshot");
    if (snapshot?.kind === "event" && snapshot.event.type === "snapshot") {
      assert.equal(snapshot.event.snapshot.state, "completed");
      assert.equal(snapshot.event.snapshot.workspaceBaseline, "0123456789abcdef");
    }
    assert.equal(applyCalls.length, 1);
    assert.equal(applyCalls[0]?.sourceRoot, workspace);
    assert.deepEqual(applyCalls[0]?.input.paths, ["src/value.ts", "new.txt"]);
    assert.deepEqual(applyCalls[0]?.input.untrackedPaths, ["new.txt"]);
    assert.equal(applyCalls[0]?.input.expectedBase, "0123456789abcdef");
  } finally {
    controller.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("app-server runs an auto Git task in a Task Worktree and hands off reviewed changes to Local", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-app-server-worktree-"));
  const worktreeRoot = path.join(root, "worktrees");
  try {
    const { repository, base } = createGitFixture(root);
    const controller = new AppServerController({
      engine: worktreeEditingEngine(),
      worktreeRoot,
    });
    const background: ProtocolMessage[] = [];
    try {
      const created = await controller.dispatch(
        command("task-worktree", "create-worktree", 0, {
          type: "task.create",
          prompt: "edit in worktree",
          approvalProfile: "auto",
          workspacePath: repository,
        }),
      );
      const createdSnapshot = created.at(-1);
      assert.ok(createdSnapshot?.kind === "event" && createdSnapshot.event.type === "snapshot");
      if (createdSnapshot?.kind === "event" && createdSnapshot.event.type === "snapshot") {
        assert.equal(createdSnapshot.event.snapshot.workspaceState, "worktree");
        assert.equal(createdSnapshot.event.snapshot.worktreePath?.startsWith(worktreeRoot), true);
        assert.equal(createdSnapshot.event.snapshot.workspaceBaseline, base);
      }
      assert.equal(existsSync(path.join(worktreeRoot, "task-worktree", "README.md")), true);
      assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "base\n");

      await controller.dispatch(
        command("task-worktree", "run-worktree", 0, { type: "task.run" }),
        (message) => background.push(message),
      );
      await waitForCompletion(background, "task-worktree");
      const changes = background.find(
        (message) => message.kind === "event" && message.event.type === "workspace.changes",
      );
      assert.ok(changes?.kind === "event" && changes.event.type === "workspace.changes");
      if (changes?.kind === "event" && changes.event.type === "workspace.changes") {
        assert.deepEqual(changes.event.tracked, ["README.md"]);
        assert.deepEqual(changes.event.untracked, ["new.txt"]);
      }

      const applied = await controller.dispatch(
        command("task-worktree", "apply-worktree", 2, {
          type: "workspace.apply",
          expectedBase: base,
          tracked: ["README.md"],
          untracked: ["new.txt"],
        }),
      );
      const appliedSnapshot = applied.at(-1);
      assert.ok(appliedSnapshot?.kind === "event" && appliedSnapshot.event.type === "snapshot");
      if (appliedSnapshot?.kind === "event" && appliedSnapshot.event.type === "snapshot") {
        assert.equal(appliedSnapshot.event.snapshot.state, "completed");
        assert.equal(appliedSnapshot.event.snapshot.workspaceState, "local");
        assert.equal(appliedSnapshot.event.snapshot.worktreePath, undefined);
      }
      assert.equal(existsSync(path.join(worktreeRoot, "task-worktree")), false);
      assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "changed by task\n");
      assert.equal(await readFile(path.join(repository, "new.txt"), "utf8"), "untracked by task\n");
      assert.equal(
        execFileSync("git", ["diff", "--cached", "--quiet"], {
          cwd: repository,
          stdio: ["ignore", "pipe", "pipe"],
        }).length,
        0,
      );
    } finally {
      controller.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("app-server discards a completed Task Worktree without touching Local", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-app-server-discard-"));
  const worktreeRoot = path.join(root, "worktrees");
  try {
    const { repository } = createGitFixture(root);
    const controller = new AppServerController({
      engine: worktreeEditingEngine(),
      worktreeRoot,
    });
    const background: ProtocolMessage[] = [];
    try {
      await controller.dispatch(
        command("task-discard", "create-discard", 0, {
          type: "task.create",
          prompt: "edit then discard",
          approvalProfile: "auto",
          workspacePath: repository,
        }),
      );
      await controller.dispatch(
        command("task-discard", "run-discard", 0, { type: "task.run" }),
        (message) => background.push(message),
      );
      await waitForCompletion(background, "task-discard");

      const discarded = await controller.dispatch(
        command("task-discard", "discard-task", 2, { type: "workspace.discard" }),
      );
      const snapshot = discarded.at(-1);
      assert.ok(snapshot?.kind === "event" && snapshot.event.type === "snapshot");
      if (snapshot?.kind === "event" && snapshot.event.type === "snapshot") {
        assert.equal(snapshot.event.snapshot.workspaceState, "local");
        assert.equal(snapshot.event.snapshot.worktreePath, undefined);
      }
      assert.equal(existsSync(path.join(worktreeRoot, "task-discard")), false);
      assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "base\n");
      assert.equal(existsSync(path.join(repository, "new.txt")), false);
    } finally {
      controller.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("app-server restores the Task Worktree association after restart and can still Apply", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-app-server-worktree-restart-"));
  const worktreeRoot = path.join(root, "worktrees");
  const databasePath = path.join(root, "state", "tasks.sqlite");
  try {
    const { repository, base } = createGitFixture(root);
    const first = new AppServerController({
      databasePath,
      engine: worktreeEditingEngine(),
      worktreeRoot,
    });
    const background: ProtocolMessage[] = [];
    try {
      await first.dispatch(
        command("task-restart-wt", "create-restart-wt", 0, {
          type: "task.create",
          prompt: "persist worktree",
          approvalProfile: "auto",
          workspacePath: repository,
        }),
      );
      await first.dispatch(
        command("task-restart-wt", "run-restart-wt", 0, { type: "task.run" }),
        (message) => background.push(message),
      );
      await waitForCompletion(background, "task-restart-wt");
    } finally {
      first.close();
    }

    const second = new AppServerController({
      databasePath,
      engine: worktreeEditingEngine(),
      worktreeRoot,
    });
    try {
      const snapshots = await second.dispatch(
        command("task-restart-wt", "snapshot-restart-wt", 2, { type: "snapshot" }),
      );
      const snapshot = snapshots.at(-1);
      assert.ok(snapshot?.kind === "event" && snapshot.event.type === "snapshot");
      if (snapshot?.kind === "event" && snapshot.event.type === "snapshot") {
        assert.equal(snapshot.event.snapshot.workspaceState, "worktree");
        assert.equal(
          snapshot.event.snapshot.worktreePath,
          path.join(worktreeRoot, "task-restart-wt"),
        );
        assert.equal(snapshot.event.snapshot.workspaceBaseline, base);
      }
      const applied = await second.dispatch(
        command("task-restart-wt", "apply-restart-wt", 2, {
          type: "workspace.apply",
          expectedBase: base,
          tracked: ["README.md"],
          untracked: ["new.txt"],
        }),
      );
      const appliedSnapshot = applied.at(-1);
      assert.ok(appliedSnapshot?.kind === "event" && appliedSnapshot.event.type === "snapshot");
      if (appliedSnapshot?.kind === "event" && appliedSnapshot.event.type === "snapshot") {
        assert.equal(appliedSnapshot.event.snapshot.workspaceState, "local");
      }
      assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "changed by task\n");
      assert.equal(existsSync(path.join(worktreeRoot, "task-restart-wt")), false);
    } finally {
      second.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("app-server blocks Apply when the reviewed manifest changed after review", async () => {
  let inspections = 0;
  const controller = new AppServerController({
    engine: {
      async *runTurn(input: AgentTurnInput) {
        yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
      },
    },
    changeTracker: {
      async captureBaseline() {
        return "0123456789abcdef";
      },
      async inspect() {
        inspections += 1;
        return {
          available: true,
          tracked: inspections === 1 ? ["src/value.ts"] : ["src/other.ts"],
          untracked: ["new.txt"],
          patchText: "diff --git a/src/value.ts b/src/value.ts\n",
          patchTruncated: false,
        };
      },
    },
  });
  const background: ProtocolMessage[] = [];
  try {
    await controller.dispatch(
      command("task-apply-stale", "create-apply-stale", 0, {
        type: "task.create",
        prompt: "review then apply",
        approvalProfile: "read-only",
        workspacePath: process.cwd(),
      }),
    );
    await controller.dispatch(
      command("task-apply-stale", "run-apply-stale", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    for (
      let attempt = 0;
      attempt < 20 &&
      !background.some(
        (message) =>
          message.kind === "event" &&
          message.event.type === "snapshot" &&
          message.event.snapshot.state === "completed",
      );
      attempt += 1
    )
      await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(
      controller.dispatch(
        command("task-apply-stale", "apply-stale", 2, {
          type: "workspace.apply",
          expectedBase: "0123456789abcdef",
          tracked: ["src/value.ts"],
          untracked: ["new.txt"],
        }),
      ),
      /changed before Apply/u,
    );
  } finally {
    controller.close();
  }
});

test("app-server persists the workspace baseline and restores it after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-app-server-baseline-"));
  const databasePath = path.join(root, "state", "tasks.sqlite");
  const observed: string[] = [];
  const changeTracker = {
    async captureBaseline() {
      return "0123456789abcdef";
    },
    async inspect(_workspace: string, baseCommit?: string) {
      observed.push(baseCommit ?? "");
      return {
        available: false,
        tracked: [],
        untracked: [],
        patchText: "",
        patchTruncated: false,
      };
    },
  };
  const first = new AppServerController({ databasePath, changeTracker });
  try {
    await first.dispatch(
      command("task-restart", "create-restart", 0, {
        type: "task.create",
        prompt: "persist baseline",
        approvalProfile: "read-only",
        workspacePath: root,
      }),
    );
  } finally {
    first.close();
  }

  const second = new AppServerController({ databasePath, changeTracker });
  try {
    const responses = await second.dispatch(
      command("task-restart", "snapshot-restart", 0, { type: "snapshot" }),
    );
    const snapshot = responses.at(-1);
    assert.ok(snapshot?.kind === "event" && snapshot.event.type === "snapshot");
    if (snapshot?.kind === "event" && snapshot.event.type === "snapshot") {
      assert.equal(snapshot.event.snapshot.workspaceBaseline, "0123456789abcdef");
    }
    assert.deepEqual(observed, ["0123456789abcdef"]);
  } finally {
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app-server rejects a secret before it can become an event", async () => {
  const controller = new AppServerController();
  try {
    await assert.rejects(
      controller.dispatch(
        command("task-secret", "create-secret", 0, {
          type: "task.create",
          prompt: "Bearer fixture-secret",
          approvalProfile: "read-only",
          workspacePath: process.cwd(),
        }),
      ),
      /secret/iu,
    );
  } finally {
    controller.close();
  }
});

test("app-server Pi bridge preserves image input for the selected provider", async () => {
  const received: PiAgentEngineInput[] = [];
  const engine = {
    async *runTurn(input: PiAgentEngineInput) {
      received.push(input);
      yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
    },
    async recoverPrompt() {
      return undefined;
    },
  };
  const bridge = new PiAppServerEngine(engine, engine);
  for await (const observation of bridge.runTurn(
    {
      taskId: "task-image-bridge",
      prompt: "describe",
      model: "MiniMax-M3",
      cwd: "/tmp/candy-workspace",
      approvalProfile: "auto",
      images: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
    },
    new AbortController().signal,
  )) {
    assert.equal(observation.type, "turn.completed");
  }
  assert.deepEqual(received[0]?.images, [{ mimeType: "image/png", data: "aW1hZ2U=" }]);
  assert.equal(received[0]?.cwd, "/tmp/candy-workspace");
  assert.equal(received[0]?.approvalProfile, "auto");
});

test("app-server preserves actionable provider error codes without exposing messages", async () => {
  const error = Object.assign(new Error("provider diagnostic must not become an event"), {
    code: "needs_credentials",
  });
  const engine = {
    async *runTurn() {
      await Promise.reject(error);
      yield { type: "turn.completed" as const, taskId: "task-provider-error", at: Date.now() };
    },
  };
  const controller = new AppServerController({ engine });
  const background: ProtocolMessage[] = [];
  try {
    await controller.dispatch(
      command("task-provider-error", "create-provider-error", 0, {
        type: "task.create",
        prompt: "run provider",
        approvalProfile: "read-only",
        workspacePath: process.cwd(),
      }),
    );
    await controller.dispatch(
      command("task-provider-error", "run-provider-error", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    for (let attempt = 0; attempt < 10 && background.length < 3; attempt += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const errorEvent = background.find(
      (message) => message.kind === "event" && message.event.type === "task.error",
    );
    assert.ok(errorEvent?.kind === "event" && errorEvent.event.type === "task.error");
    if (errorEvent?.kind === "event" && errorEvent.event.type === "task.error") {
      assert.equal(errorEvent.event.code, "needs_credentials");
      assert.equal(JSON.stringify(errorEvent).includes("provider diagnostic"), false);
    }
  } finally {
    controller.close();
  }
});

test("app-server keeps DeepSeek rate limiting isolated from MiniMax and local reads", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "candy-provider-isolation-"));
  const calls: string[] = [];
  const engine = {
    async *runTurn(input: AgentTurnInput) {
      calls.push(`${input.model}:${input.prompt}`);
      if (input.model === "deepseek-v4-flash")
        throw new ProviderContractError("DeepSeek rate limit", "provider_error");
      if (input.model === "MiniMax-M3") {
        await writeFile(path.join(input.cwd ?? workspace, "minimax.txt"), "ok\n");
      }
      yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
    },
  };
  const controller = new AppServerController({ engine });
  const background: ProtocolMessage[] = [];
  try {
    await controller.dispatch(
      command("task-deepseek-limit", "create-ds", 0, {
        type: "task.create",
        prompt: "deepseek turn",
        approvalProfile: "read-only",
        workspacePath: workspace,
        model: "deepseek-v4-flash",
      }),
    );
    await controller.dispatch(
      command("task-minimax-ok", "create-mm", 0, {
        type: "task.create",
        prompt: "minimax turn",
        approvalProfile: "read-only",
        workspacePath: workspace,
        model: "MiniMax-M3",
      }),
    );
    await controller.dispatch(
      command("task-deepseek-limit", "run-ds", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    await controller.dispatch(
      command("task-minimax-ok", "run-mm", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const bothDone =
        background.some(
          (message) =>
            message.kind === "event" &&
            message.event.type === "snapshot" &&
            message.event.snapshot.taskId === "task-minimax-ok" &&
            message.event.snapshot.state === "completed",
        ) &&
        background.some(
          (message) =>
            message.kind === "event" &&
            message.event.type === "task.error" &&
            message.event.code === "provider_error",
        );
      if (bothDone) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const miniMaxCompleted = background.some(
      (message) =>
        message.kind === "event" &&
        message.event.type === "snapshot" &&
        message.event.snapshot.taskId === "task-minimax-ok" &&
        message.event.snapshot.state === "completed",
    );
    assert.equal(miniMaxCompleted, true);
    assert.equal(
      background.some(
        (message) =>
          message.kind === "event" &&
          message.event.type === "task.error" &&
          message.event.code === "provider_error",
      ),
      true,
      JSON.stringify(
        background.map((message) =>
          message.kind === "event"
            ? `${message.event.type}:${"code" in message.event ? message.event.code : ""}`
            : message.kind,
        ),
      ),
    );
    assert.ok(calls.some((call) => call.startsWith("MiniMax-M3:")));
    assert.ok(calls.some((call) => call.startsWith("deepseek-v4-flash:")));
    const localRead = await readFile(path.join(workspace, "minimax.txt"), "utf8");
    assert.equal(localRead, "ok\n");
  } finally {
    controller.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("app-server keeps a running task read-only to a second owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-app-server-owners-"));
  const databasePath = path.join(root, "state", "tasks.sqlite");
  let releaseTurn: (() => void) | undefined;
  const turnReleased = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const ownerEngine = {
    async *runTurn(input: AgentTurnInput) {
      resolveStarted?.();
      await turnReleased;
      yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
    },
  };
  const first = new AppServerController({ databasePath, engine: ownerEngine, ownerId: "owner-1" });
  const second = new AppServerController({
    databasePath,
    ownerId: "owner-2",
  });
  try {
    await first.dispatch(
      command("task-owned", "create-owned", 0, {
        type: "task.create",
        prompt: "owned task",
        approvalProfile: "read-only",
        workspacePath: root,
      }),
    );
    await first.dispatch(command("task-owned", "run-owned", 0, { type: "task.run" }), (message) => {
      if (
        message.kind === "event" &&
        message.event.type === "snapshot" &&
        message.event.snapshot.state === "completed"
      )
        resolveCompleted?.();
    });
    await started;
    const remoteCancel = await second.dispatch(
      command("task-owned", "remote-cancel", 1, { type: "task.cancel" }),
    );
    const snapshot = remoteCancel.at(-1);
    assert.ok(snapshot?.kind === "event" && snapshot.event.type === "snapshot");
    if (snapshot?.kind === "event" && snapshot.event.type === "snapshot") {
      assert.equal(snapshot.event.snapshot.state, "running");
      assert.equal(snapshot.event.snapshot.ownerId, "owner-1");
    }
    releaseTurn?.();
    await completed;
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app-server rejects a second owner approval response without resolving the request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-app-server-approval-owners-"));
  const databasePath = path.join(root, "state", "tasks.sqlite");
  const { repository } = createGitFixture(root);
  const worktreeRoot = path.join(root, "worktrees");
  const background: ProtocolMessage[] = [];
  const first = new AppServerController({
    databasePath,
    ownerId: "owner-1",
    worktreeRoot,
    bashRunner: {
      run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", cancelled: false }),
    },
    engine: {
      async *runTurn(input: AgentTurnInput) {
        if (!input.shellApproval) throw new Error("shell approval missing");
        await input.shellApproval(
          { command: "git status --short", cwd: input.cwd! },
          new AbortController().signal,
        );
        yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
      },
    },
  });
  const second = new AppServerController({ databasePath, ownerId: "owner-2" });
  try {
    await first.dispatch(
      command("approval-owner-task", "create", 0, {
        type: "task.create",
        prompt: "inspect",
        approvalProfile: "auto",
        trustedShell: true,
        workspacePath: repository,
      }),
    );
    await first.dispatch(
      command("approval-owner-task", "run", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    const waiting = await waitForSnapshotState(
      background,
      "approval-owner-task",
      "waiting_approval",
    );
    const remote = await second.dispatch(
      command("approval-owner-task", "remote-approve", waiting.revision, {
        type: "approval.respond",
        approvalId: waiting.event.snapshot.approvalId!,
        decision: "approve",
      }),
    );
    const remoteSnapshot = remote.at(-1);
    assert.ok(remoteSnapshot?.kind === "event" && remoteSnapshot.event.type === "snapshot");
    if (remoteSnapshot?.kind === "event" && remoteSnapshot.event.type === "snapshot") {
      assert.equal(remoteSnapshot.event.snapshot.state, "waiting_approval");
      assert.equal(remoteSnapshot.event.snapshot.ownerId, "owner-1");
    }
    assert.equal(
      background.some(
        (message) => message.kind === "event" && message.event.type === "tool.completed",
      ),
      false,
    );
    const denied = await first.dispatch(
      command("approval-owner-task", "approve", waiting.revision, {
        type: "approval.respond",
        approvalId: waiting.event.snapshot.approvalId!,
        decision: "deny",
      }),
      (message) => background.push(message),
    );
    const deniedSnapshot = denied.at(-1);
    assert.ok(deniedSnapshot?.kind === "event" && deniedSnapshot.event.type === "snapshot");
    if (deniedSnapshot?.kind === "event" && deniedSnapshot.event.type === "snapshot")
      assert.equal(deniedSnapshot.event.snapshot.state, "paused");
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app-server resolves Candy-owned image attachments into the selected MiniMax turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-app-server-attachments-"));
  const attachmentStore = new AttachmentStore(path.join(root, "attachments"));
  let observedImages = 0;
  let resolveObservedImages: (() => void) | undefined;
  const imagesObserved = new Promise<void>((resolve) => {
    resolveObservedImages = resolve;
  });
  const engine = {
    async *runTurn(input: AgentTurnInput) {
      observedImages = input.images?.length ?? 0;
      resolveObservedImages?.();
      yield { type: "turn.completed" as const, taskId: "task-image", at: Date.now() };
    },
  };
  const attachment = await attachmentStore.put(
    "image",
    "image/png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const controller = new AppServerController({ engine, attachments: attachmentStore });
  const background: ProtocolMessage[] = [];
  try {
    await controller.dispatch(
      command("task-image", "create-image", 0, {
        type: "task.create",
        prompt: "describe image",
        approvalProfile: "read-only",
        workspacePath: root,
        model: "MiniMax-M3",
        attachmentIds: [attachment.id],
      }),
    );
    await controller.dispatch(
      command("task-image", "run-image", 0, { type: "task.run" }),
      (message) => background.push(message),
    );
    await imagesObserved;
    await waitForCompletion(background, "task-image");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(observedImages, 1);
    assert.equal(
      background.some(
        (message) =>
          message.kind === "event" &&
          message.event.type === "snapshot" &&
          message.event.snapshot.state === "completed",
      ),
      true,
      JSON.stringify(background),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app-server limits starts to three active tasks and promotes queued FIFO work", async () => {
  let active = 0;
  let maximumActive = 0;
  const started = new Set<string>();
  const gateResolvers = new Map<string, () => void>();
  let resolveThreeStarted: (() => void) | undefined;
  const threeStarted = new Promise<void>((resolve) => {
    resolveThreeStarted = resolve;
  });
  let resolveAllCompleted: (() => void) | undefined;
  const allCompleted = new Promise<void>((resolve) => {
    resolveAllCompleted = resolve;
  });
  const completed = new Set<string>();
  const engine = {
    async *runTurn(input: AgentTurnInput) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.add(input.taskId);
      if (started.size === 3) resolveThreeStarted?.();
      await new Promise<void>((resolve) => gateResolvers.set(input.taskId, resolve));
      active -= 1;
      yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
    },
  };
  const controller = new AppServerController({
    engine,
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
  });
  const background = new Map<string, ProtocolMessage[]>();
  try {
    for (let index = 1; index <= 4; index += 1) {
      const taskId = `task-fifo-${index}`;
      background.set(taskId, []);
      await controller.dispatch(
        command(taskId, `create-${index}`, 0, {
          type: "task.create",
          prompt: taskId,
          approvalProfile: "read-only",
          workspacePath: process.cwd(),
        }),
      );
      await controller.dispatch(
        command(taskId, `run-${index}`, 0, { type: "task.run" }),
        (message) => {
          background.get(taskId)?.push(message);
          if (
            message.kind === "event" &&
            message.event.type === "snapshot" &&
            message.event.snapshot.state === "completed"
          ) {
            completed.add(taskId);
            if (completed.size === 4) resolveAllCompleted?.();
          }
        },
      );
    }
    await threeStarted;
    const queuedSnapshot = (
      await controller.dispatch(command("task-fifo-4", "snapshot-4", 0, { type: "snapshot" }))
    ).at(-1);
    assert.ok(queuedSnapshot?.kind === "event");
    if (queuedSnapshot?.kind === "event" && queuedSnapshot.event.type === "snapshot") {
      assert.equal(queuedSnapshot.event.snapshot.state, "queued");
      assert.equal(queuedSnapshot.event.snapshot.revision, 0);
    }
    assert.equal(started.has("task-fifo-4"), false);
    gateResolvers.get("task-fifo-1")?.();
    for (let attempt = 0; attempt < 20 && !started.has("task-fifo-4"); attempt += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(started.has("task-fifo-4"), true);
    for (const resolve of gateResolvers.values()) resolve();
    await allCompleted;
    assert.equal(maximumActive <= 3, true);
  } finally {
    controller.close();
  }
});

test("app-server reorders queued run requests before promoting the next task", async () => {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  let releaseInitialTasks: (() => void) | undefined;
  const initialTasksStarted = new Promise<void>((resolve) => {
    releaseInitialTasks = resolve;
  });
  const engine = {
    async *runTurn(input: AgentTurnInput) {
      started.push(input.taskId);
      if (started.length === 3) releaseInitialTasks?.();
      await new Promise<void>((resolve) => gates.set(input.taskId, resolve));
      yield { type: "turn.completed" as const, taskId: input.taskId, at: Date.now() };
    },
  };
  const controller = new AppServerController({
    engine,
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
  });
  try {
    for (let index = 1; index <= 5; index += 1) {
      const taskId = `task-reorder-${index}`;
      await controller.dispatch(
        command(taskId, `create-reorder-${index}`, 0, {
          type: "task.create",
          prompt: taskId,
          approvalProfile: "read-only",
          workspacePath: process.cwd(),
        }),
      );
      await controller.dispatch(command(taskId, `run-reorder-${index}`, 0, { type: "task.run" }));
    }
    await initialTasksStarted;
    await controller.dispatch(
      command("task-reorder-5", "reorder-5", 0, {
        type: "task.reorder",
        beforeTaskId: "task-reorder-4",
      }),
    );
    gates.get("task-reorder-1")?.();
    for (let attempt = 0; attempt < 20 && !started.includes("task-reorder-5"); attempt += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(started.slice(0, 4), [
      "task-reorder-1",
      "task-reorder-2",
      "task-reorder-3",
      "task-reorder-5",
    ]);
    for (const resolve of gates.values()) resolve();
  } finally {
    controller.close();
  }
});
