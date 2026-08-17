import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderContractError } from "@candy/pi-adapter";
import { InMemoryCredentialStore, resolveAppPaths, SQLiteTaskStore } from "@candy/platform";
import type {
  CommandValidatorCommand,
  ValidatorResult,
  WorkspaceChangeSnapshot,
  WorkspaceChangeTracker,
} from "@candy/runtime";
import {
  createDefaultInteractiveTui,
  InteractiveTui,
  isMacosTrustedShellAutoAvailable,
  type TuiAgentEngine,
} from "./main.js";
import { FakeTerminal } from "./pi-tui-surface.js";

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

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function createTuiGitFixture(root: string): Promise<string> {
  const repository = path.join(root, "repository");
  await mkdir(repository);
  runGit(repository, ["init", "-q"]);
  await writeFile(path.join(repository, "README.md"), "base\n");
  runGit(repository, ["add", "README.md"]);
  runGit(repository, [
    "-c",
    "user.name=Candy Fixture",
    "-c",
    "user.email=candy-fixture@example.invalid",
    "commit",
    "-qm",
    "base",
  ]);
  return repository;
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

test("interactive TUI manages OS credential presence without reading back secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-credentials-"));
  const terminal = new FakeTerminal();
  const credentials = new InMemoryCredentialStore();
  const environment = { [["CANDY", "DEEPSEEK", "API", "KEY"].join("_")]: "test-secret" };
  try {
    const runPromise = new InteractiveTui({
      appDataRoot: root,
      terminal,
      credentialStore: credentials,
      credentialEnvironment: environment,
      engine: {
        async *runTurn(input) {
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(":credentials");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /deepseek: absent/u);
    terminal.emitInput(":credential set deepseek");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /deepseek credential set \(present\)/u);
    terminal.emitInput(":credential replace deepseek");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /deepseek credential replace \(present\)/u);
    terminal.emitInput(":credential delete deepseek");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /deepseek credential deleted/u);
    terminal.emitInput(":credential set deepseek test-secret");
    terminal.emitInput("\r");
    const output = await waitForOutput(terminal, /credential rejected/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
    assert.equal(credentials.has("deepseek"), "absent");
    assert.doesNotMatch(output, /test-secret/u);
    assert.doesNotMatch(terminal.writes.join(""), /test-secret/u);
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
      new RegExp(
        `recovery: :resume ${taskId} <continuation>[\\s\\S]*deepseek-pro[\\s\\S]*:cancel`,
        "u",
      ),
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
    const approvalOutput = await waitForOutput(
      terminal,
      /approval required: delete obsolete\.ts[\s\S]*:approve delete-[a-z0-9]+/u,
      5_000,
    );
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

test("interactive TUI bounds and redacts tool visibility while steering and cancelling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-steering-"));
  const terminal = new FakeTerminal();
  const steering: string[] = [];
  const followUps: string[] = [];
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input, signal) {
        yield { type: "turn.started", taskId: input.taskId };
        yield {
          type: "tool.started",
          taskId: input.taskId,
          tool: "candy_read",
          toolCallId: "call-1",
          args: '{"path":"src/value.ts","token":"sk-proj-tool-output-canary-1234567890"}',
        };
        yield {
          type: "tool.updated",
          taskId: input.taskId,
          tool: "candy_read",
          toolCallId: "call-1",
          output: '{"content":"partial fixture output"}',
        };
        yield {
          type: "tool.completed",
          taskId: input.taskId,
          tool: "candy_" + "x".repeat(300),
          ok: true,
          output: '{"path":"src/value.ts","token":"sk-proj-tool-output-canary-1234567890"}',
        };
        yield {
          type: "tool.completed",
          taskId: input.taskId,
          tool: "sk-proj-tool-output-canary-1234567890",
          ok: true,
          output: "Bearer fixture-secret-value-0123456789",
        };
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            signal.removeEventListener("abort", onAbort);
            reject(new Error("cancelled"));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          void input;
          void resolve;
        });
      },
      async steer(_taskId, text) {
        steering.push(text);
      },
      async followUp(_taskId, text) {
        followUps.push(text);
      },
    };
    const runPromise = new InteractiveTui({ appDataRoot: root, engine, terminal }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput("start a long turn");
    terminal.emitInput("\r");
    const taskOutput = await waitForOutput(terminal, /\[tool candy_/u);
    const updatedOutput = await waitForOutput(terminal, /partial fixture output/u);
    const completedOutput = await waitForOutput(terminal, /output=.*\[REDACTED\]/u);
    assert.doesNotMatch(taskOutput, /x{150}/u);
    assert.match(taskOutput, /args=.*src\/value\.ts/u);
    assert.match(updatedOutput, /output=.*partial fixture output/u);
    assert.match(completedOutput, /\[REDACTED\]/u);
    assert.doesNotMatch(completedOutput, /sk-proj-tool-output-canary|Bearer fixture-secret/u);
    const redactedToolOutput = await waitForOutput(terminal, /\[tool \[REDACTED\]/u);
    assert.match(redactedToolOutput, /\[tool \[REDACTED\]/u);
    const taskId = taskOutput.match(/created (task-[a-z0-9]+)/u)?.[1];
    assert.ok(taskId);
    terminal.emitInput(":steer focus on the failing test");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /steering queued/u);
    terminal.emitInput(":follow-up report only after validation");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /follow-up queued/u);
    terminal.emitInput(`:steer ${"x".repeat(4_097)}`);
    terminal.emitInput("\r");
    await waitForOutput(terminal, /turn message rejected: text exceeds 4096 characters/u);
    terminal.emitInput(`:cancel ${taskId}`);
    terminal.emitInput("\r");
    await waitForOutput(terminal, new RegExp(`${taskId} cancelled`, "u"));
    terminal.emitInput("\x03");
    await runPromise;
    assert.deepEqual(steering, ["focus on the failing test"]);
    assert.deepEqual(followUps, ["report only after validation"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI projects retry and compaction until the turn settles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-lifecycle-"));
  const terminal = new FakeTerminal();
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        yield { type: "turn.started", taskId: input.taskId };
        yield {
          type: "turn.retrying",
          taskId: input.taskId,
          attempt: 1,
          maxAttempts: 3,
          delayMs: 1,
        };
        yield { type: "turn.retry.completed", taskId: input.taskId, attempt: 1, ok: true };
        yield {
          type: "turn.compaction",
          taskId: input.taskId,
          phase: "started",
          reason: "overflow",
        };
        yield {
          type: "turn.compaction",
          taskId: input.taskId,
          phase: "completed",
          reason: "overflow",
          aborted: false,
          willRetry: true,
        };
        yield { type: "assistant.delta", taskId: input.taskId, text: "recovered after compaction" };
        yield { type: "turn.settled", taskId: input.taskId };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const runPromise = new InteractiveTui({ appDataRoot: root, terminal, engine }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput("recover the turn");
    terminal.emitInput("\r");
    const output = await waitForOutput(terminal, /completed/u);
    assert.match(output, /provider retry 1\/3; waiting 1ms/u);
    assert.match(output, /provider retry 1 succeeded/u);
    assert.match(output, /context compaction: overflow/u);
    assert.match(output, /context compaction settled: overflow/u);
    assert.match(output, /turn settled/u);
    assert.match(output, /recovered after compaction/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI cancels a turn while compaction is in progress", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-compaction-cancel-"));
  const terminal = new FakeTerminal();
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input, signal) {
        yield { type: "turn.started", taskId: input.taskId };
        yield {
          type: "turn.compaction",
          taskId: input.taskId,
          phase: "started",
          reason: "overflow",
        };
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            signal.removeEventListener("abort", onAbort);
            reject(new Error("compaction cancelled"));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          void resolve;
        });
      },
    };
    const runPromise = new InteractiveTui({ appDataRoot: root, terminal, engine }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput("recover during compaction");
    terminal.emitInput("\r");
    const compactionOutput = await waitForOutput(terminal, /context compaction: overflow/u);
    const taskId = compactionOutput.match(/created (task-[a-z0-9]+)/u)?.[1];
    assert.ok(taskId);
    terminal.emitInput(`:cancel ${taskId}`);
    terminal.emitInput("\r");
    const cancelledOutput = await waitForOutput(terminal, new RegExp(`${taskId} cancelled`, "u"));
    assert.match(cancelledOutput, /context compaction: overflow/u);
    assert.doesNotMatch(cancelledOutput, /context compaction settled|turn settled| completed/u);
    terminal.emitInput("\x03");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI enables Trusted Shell Auto in the accepted macOS composition root", async () => {
  if (!isMacosTrustedShellAutoAvailable()) return;
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-trusted-shell-default-on-"));
  const repository = await createTuiGitFixture(root);
  const terminal = new FakeTerminal();
  try {
    const runPromise = createDefaultInteractiveTui({
      appDataRoot: path.join(root, "app-data"),
      workspacePath: repository,
      terminal,
      shellRunner: {
        run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", cancelled: false }),
      },
      engine: {
        async *runTurn(input) {
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(":profile auto");
    terminal.emitInput("\r");
    terminal.emitInput(":trusted-shell on");
    terminal.emitInput("\r");
    const output = await waitForOutput(
      terminal,
      /Trusted Shell Auto enabled for the next Auto Git Task/u,
    );
    assert.match(output, /Trusted Shell Auto enabled for the next Auto Git Task/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI explicitly enables macOS Trusted Shell Auto only for Git Task Worktrees", async () => {
  if (!isMacosTrustedShellAutoAvailable()) return;
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-trusted-shell-"));
  const repository = await createTuiGitFixture(root);
  const terminal: FakeTerminal = new FakeTerminal();
  const shellRunner = {
    async run() {
      return { code: 0, signal: null, stdout: "", stderr: "", cancelled: false };
    },
  };
  let observedTrustedShell = false;
  try {
    const runPromise = new InteractiveTui({
      appDataRoot: path.join(root, "app-data"),
      workspacePath: repository,
      terminal,
      shellRunner,
      trustedShellAutoAvailable: true,
      engine: {
        async *runTurn(input) {
          observedTrustedShell = input.trustedShell === true;
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "assistant.delta", taskId: input.taskId, text: "shell-ready" };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(":profile auto");
    terminal.emitInput("\r");
    terminal.emitInput(":trusted-shell on");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /Trusted Shell Auto enabled/u);
    terminal.emitInput("inspect with shell enabled");
    terminal.emitInput("\r");
    const output = await waitForOutput(terminal, /shell-ready/u);
    const store = new SQLiteTaskStore(
      path.join(resolveAppPaths(path.join(root, "app-data")).state, "tasks.sqlite"),
    );
    const task = store.list()[0];
    assert.ok(task);
    assert.equal(task.trustedShell, true);
    assert.equal(task.approvalProfile, "auto");
    assert.ok(task.worktreePath);
    assert.equal(observedTrustedShell, true);
    assert.match(output, /Trusted Shell Auto enabled/u);
    terminal.emitInput(":discard");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /discarded task-/u);
    store.close();
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI passes all active provider secrets to Trusted Shell redaction", async () => {
  if (!isMacosTrustedShellAutoAvailable()) return;
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-trusted-shell-secrets-"));
  const repository = await createTuiGitFixture(root);
  const terminal = new FakeTerminal();
  let observedSecrets: readonly string[] | undefined;
  try {
    const runPromise = new InteractiveTui({
      appDataRoot: path.join(root, "app-data"),
      workspacePath: repository,
      terminal,
      activeSecrets: () => ["deepseek-secret", "minimax-secret"],
      shellRunner: {
        run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", cancelled: false }),
      },
      trustedShellAutoAvailable: true,
      engine: {
        async *runTurn(input) {
          observedSecrets = input.shellActiveSecrets;
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(":profile auto");
    terminal.emitInput("\r");
    terminal.emitInput(":trusted-shell on");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /Trusted Shell Auto enabled/u);
    terminal.emitInput("run with complete credential redaction");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /completed/u);
    assert.deepEqual(observedSecrets, ["deepseek-secret", "minimax-secret"]);
    terminal.emitInput(":discard");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /discarded task-/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI presents one-command network elevation and leaves the task resumable on denial", async () => {
  if (!isMacosTrustedShellAutoAvailable()) return;
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-network-approval-"));
  const repository = await createTuiGitFixture(root);
  const terminal: FakeTerminal = new FakeTerminal();
  const decisions: boolean[] = [];
  try {
    const runPromise = new InteractiveTui({
      appDataRoot: path.join(root, "app-data"),
      workspacePath: repository,
      terminal,
      trustedShellAutoAvailable: true,
      shellRunner: {
        run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", cancelled: false }),
      },
      engine: {
        async *runTurn(input, signal) {
          yield { type: "turn.started", taskId: input.taskId };
          const approved = await input.shellNetworkApproval?.(
            {
              command: "git fetch origin",
              cwd: input.cwd,
              reason: "refresh the repository metadata requested by the user",
              timeout: 15,
            },
            signal,
          );
          decisions.push(approved === true);
          if (approved)
            yield {
              type: "tool.completed",
              taskId: input.taskId,
              tool: "candy_bash_network",
              ok: true,
            };
          else throw new Error("network request denied");
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(":profile auto");
    terminal.emitInput("\r");
    terminal.emitInput(":trusted-shell on");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /Trusted Shell Auto enabled/u);
    terminal.emitInput("fetch metadata");
    terminal.emitInput("\r");
    const waiting = await waitForOutput(
      terminal,
      /network approval required[\s\S]*git fetch origin/u,
    );
    const approvalId = waiting.match(/:deny (network-[a-z0-9]+)/u)?.[1];
    assert.ok(approvalId);
    terminal.emitInput(`:deny ${approvalId}`);
    terminal.emitInput("\r");
    const denied = await waitForOutput(terminal, /network denied/u);
    assert.match(denied, /interrupted/u);
    assert.deepEqual(decisions, [false]);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI settles network approval on exit and rejects stale approval after restart", async () => {
  if (!isMacosTrustedShellAutoAvailable()) return;
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-network-exit-"));
  const appDataRoot = path.join(root, "app-data");
  const repository = await createTuiGitFixture(root);
  const terminal = new FakeTerminal();
  const decisions: boolean[] = [];
  let firstEngineCalls = 0;
  try {
    const firstRun = new InteractiveTui({
      appDataRoot,
      workspacePath: repository,
      terminal,
      trustedShellAutoAvailable: true,
      shellRunner: {
        run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", cancelled: false }),
      },
      engine: {
        async *runTurn(input, signal) {
          firstEngineCalls += 1;
          yield { type: "turn.started", taskId: input.taskId };
          const approved = await input.shellNetworkApproval?.(
            {
              command: "git ls-remote origin HEAD",
              cwd: input.cwd,
              reason: "inspect the configured remote revision",
            },
            signal,
          );
          decisions.push(approved === true);
          if (approved) {
            yield {
              type: "tool.completed",
              taskId: input.taskId,
              tool: "candy_bash_network",
              ok: true,
            };
            yield { type: "turn.completed", taskId: input.taskId };
          } else {
            throw new Error("network request denied on exit");
          }
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(":profile auto");
    terminal.emitInput("\r");
    terminal.emitInput(":trusted-shell on");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /Trusted Shell Auto enabled/u);
    terminal.emitInput("inspect remote");
    terminal.emitInput("\r");
    const waiting = await waitForOutput(
      terminal,
      /network approval required[\s\S]*git ls-remote origin HEAD/u,
    );
    const staleApprovalId = waiting.match(/:approve (network-[a-z0-9]+)/u)?.[1];
    assert.ok(staleApprovalId);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await firstRun;

    assert.deepEqual(decisions, [false]);
    assert.equal(firstEngineCalls, 1);
    const afterExit = new SQLiteTaskStore(
      path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"),
    );
    const interrupted = afterExit.list()[0];
    assert.equal(interrupted?.state, "interrupted");
    assert.equal(interrupted?.ownerId, undefined);
    afterExit.close();

    const secondTerminal = new FakeTerminal();
    let secondEngineCalls = 0;
    const secondRun = new InteractiveTui({
      appDataRoot,
      workspacePath: repository,
      terminal: secondTerminal,
      trustedShellAutoAvailable: true,
      engine: {
        async *runTurn(input) {
          secondEngineCalls += 1;
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    secondTerminal.emitInput(":tasks");
    secondTerminal.emitInput("\r");
    await waitForOutput(secondTerminal, /interrupted/u);
    secondTerminal.emitInput(`:approve ${staleApprovalId}`);
    secondTerminal.emitInput("\r");
    await waitForOutput(secondTerminal, /is not awaiting approval/u);
    secondTerminal.emitInput(":quit");
    secondTerminal.emitInput("\r");
    await secondRun;
    assert.equal(secondEngineCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI aborts a pending network request when its owner is fenced", async () => {
  if (!isMacosTrustedShellAutoAvailable()) return;
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-owner-fence-"));
  const appDataRoot = path.join(root, "app-data");
  const repository = await createTuiGitFixture(root);
  const terminal = new FakeTerminal();
  const decisions: boolean[] = [];
  try {
    const runPromise = new InteractiveTui({
      appDataRoot,
      workspacePath: repository,
      terminal,
      trustedShellAutoAvailable: true,
      shellRunner: {
        run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", cancelled: false }),
      },
      engine: {
        async *runTurn(input, signal) {
          yield { type: "turn.started", taskId: input.taskId };
          const approved = await input.shellNetworkApproval?.(
            {
              command: "git ls-remote origin HEAD",
              cwd: input.cwd,
              reason: "inspect the configured remote revision",
            },
            signal,
          );
          decisions.push(approved === true);
          if (approved) throw new Error("owner fence must not approve network");
          throw new Error("network request was fenced");
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(":profile auto");
    terminal.emitInput("\r");
    terminal.emitInput(":trusted-shell on");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /Trusted Shell Auto enabled/u);
    terminal.emitInput("inspect remote");
    terminal.emitInput("\r");
    const waiting = await waitForOutput(
      terminal,
      /network approval required[\s\S]*git ls-remote origin HEAD/u,
    );
    const taskId = waiting.match(/created (task-[a-z0-9]+)/u)?.[1];
    assert.ok(taskId);
    const ownerStore = new SQLiteTaskStore(
      path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"),
    );
    const ownerId = ownerStore.get(taskId)?.ownerId;
    assert.ok(ownerId);
    assert.equal(ownerStore.markOwnerInterrupted(ownerId), 1);
    ownerStore.close();

    for (let attempt = 0; attempt < 100 && decisions.length === 0; attempt += 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(decisions, [false]);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;

    const recovered = new SQLiteTaskStore(
      path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"),
    );
    assert.equal(recovered.get(taskId)?.state, "interrupted");
    assert.equal(recovered.get(taskId)?.ownerId, undefined);
    recovered.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI recovers a dead owner without replaying a waiting network task", async () => {
  if (!isMacosTrustedShellAutoAvailable()) return;
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-owner-loss-"));
  const appDataRoot = path.join(root, "app-data");
  const repository = await createTuiGitFixture(root);
  const store = new SQLiteTaskStore(path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"));
  store.create(
    "task-dead-owner",
    "auto",
    1,
    "deepseek-v4-flash",
    [],
    repository,
    undefined,
    undefined,
    path.join(resolveAppPaths(appDataRoot).worktrees, "task-dead-owner"),
    true,
  );
  store.transition("task-dead-owner", 0, "waiting_approval", "tui:999999");
  store.close();
  const terminal = new FakeTerminal();
  let engineCalls = 0;
  try {
    const runPromise = new InteractiveTui({
      appDataRoot,
      workspacePath: repository,
      terminal,
      trustedShellAutoAvailable: true,
      engine: {
        async *runTurn(input) {
          engineCalls += 1;
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(":tasks");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /task-dead-owner\tinterrupted\t/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
    assert.equal(engineCalls, 0);
    const recovered = new SQLiteTaskStore(
      path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"),
    );
    assert.equal(recovered.get("task-dead-owner")?.state, "interrupted");
    assert.equal(recovered.get("task-dead-owner")?.ownerId, undefined);
    recovered.close();
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

test("interactive TUI reports malformed and conflicting Candy resource diagnostics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-resource-diagnostics-"));
  const terminal = new FakeTerminal();
  try {
    await mkdir(path.join(root, "skills", "broken"), { recursive: true });
    await mkdir(path.join(root, "prompts"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "broken", "SKILL.md"),
      "---\nname: broken\n---\nThis skill is malformed.\n",
    );
    await writeFile(
      path.join(root, "prompts", "first.md"),
      "---\nname: duplicate\n---\nFirst prompt\n",
    );
    await writeFile(
      path.join(root, "prompts", "second.md"),
      "---\nname: duplicate\n---\nSecond prompt\n",
    );
    const runPromise = new InteractiveTui({
      appDataRoot: root,
      terminal,
      engine: {
        async *runTurn(input) {
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(":resources");
    terminal.emitInput("\r");
    const output = await waitForOutput(terminal, /prompt resource collision/u);
    assert.match(
      output,
      /skill resource error: Candy skill requires frontmatter name and description/u,
    );
    assert.match(output, /prompt resource collision: prompt name "duplicate" collision/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI lists and invokes Candy-owned prompt templates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-prompt-template-"));
  const terminal = new FakeTerminal();
  const prompts: string[] = [];
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      prompts.push(input.prompt);
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "assistant.delta", taskId: input.taskId, text: "prompt invoked" };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    await mkdir(path.join(root, "prompts"), { recursive: true });
    await writeFile(
      path.join(root, "prompts", "review.md"),
      "---\nname: review\ndescription: Review a change\nargument-hint: <path>\n---\nReview $1\nKeep fixture-secret private.\n",
    );
    const runPromise = new InteractiveTui({
      appDataRoot: root,
      activeSecrets: () => ["fixture-secret"],
      engine,
      terminal,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));

    terminal.emitInput(":prompts");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /review\tReview a change\t<path>/u);
    terminal.emitInput(':prompt review "src/file with spaces.ts"');
    terminal.emitInput("\r");
    await waitForOutput(terminal, /prompt invoked/u);
    assert.deepEqual(prompts, ["Review src/file with spaces.ts\nKeep [REDACTED] private.\n"]);

    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI rejects unknown or unsafe prompt template invocations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-prompt-template-reject-"));
  const terminal = new FakeTerminal();
  try {
    await mkdir(path.join(root, "prompts"), { recursive: true });
    await writeFile(path.join(root, "prompts", "review.md"), "Review $1\n");
    const runPromise = new InteractiveTui({ appDataRoot: root, terminal }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));

    terminal.emitInput(":prompt missing value");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /prompt template not found: missing/u);
    terminal.emitInput(`:prompt review ${"x".repeat(4_097)}`);
    terminal.emitInput("\r");
    await waitForOutput(terminal, /prompt arguments rejected/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI selects an existing workspace for new tasks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-workspace-command-app-"));
  const firstWorkspace = await mkdtemp(path.join(tmpdir(), "candy-tui-workspace command-first-"));
  const secondWorkspace = await mkdtemp(path.join(tmpdir(), "candy-tui-workspace command-second-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const workspaces: string[] = [];
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      workspaces.push(input.cwd);
      yield { type: "turn.started", taskId: input.taskId };
      yield {
        type: "assistant.delta",
        taskId: input.taskId,
        text: `workspace selected ${workspaces.length}`,
      };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    const runPromise = new InteractiveTui({ appDataRoot: root, engine, terminal }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));

    terminal.emitInput(":workspace relative");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /Workspace paths must be absolute/u);

    terminal.emitInput(`:workspace ${firstWorkspace}`);
    terminal.emitInput("\r");
    await waitForOutput(terminal, /workspace selected:/u);
    terminal.emitInput("work in the first workspace");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /created task-/u);
    await waitForOutput(terminal, /task-[a-z0-9]+ completed/u);

    terminal.emitInput(`:workspace ${secondWorkspace}`);
    terminal.emitInput("\r");
    await waitForOutput(
      terminal,
      new RegExp(`workspace selected: .*${path.basename(secondWorkspace)}`, "u"),
    );
    terminal.emitInput(":new");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /new task ready/u);
    terminal.emitInput("work in the second workspace");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /workspace selected 2/u);

    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;

    const expectedWorkspaces = [
      await realpath(firstWorkspace),
      await realpath(secondWorkspace),
    ].sort();
    assert.deepEqual([...workspaces].sort(), expectedWorkspaces);
    const store = new SQLiteTaskStore(path.join(resolveAppPaths(root).state, "tasks.sqlite"));
    assert.deepEqual(
      store
        .list()
        .map((task) => task.workspacePath)
        .sort(),
      expectedWorkspaces,
    );
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(firstWorkspace, { recursive: true, force: true });
    await rm(secondWorkspace, { recursive: true, force: true });
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

test("interactive TUI never replays an interrupted prompt and requires explicit continuation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-explicit-recovery-"));
  const firstTerminal = new FakeTerminal();
  try {
    const firstRun = new InteractiveTui({
      appDataRoot: root,
      terminal: firstTerminal,
      engine: {
        async *runTurn(input) {
          yield { type: "turn.started", taskId: input.taskId };
          yield {
            type: "assistant.delta",
            taskId: input.taskId,
            text: "partial side-effect evidence",
          };
          throw new Error("ambiguous side effect");
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    firstTerminal.emitInput("perform the original operation");
    firstTerminal.emitInput("\r");
    const firstOutput = await waitForOutput(firstTerminal, /ambiguous side effect/u);
    const taskId = firstOutput.match(/created (task-[a-z0-9]+)/u)?.[1];
    assert.ok(taskId);
    firstTerminal.emitInput(":quit");
    firstTerminal.emitInput("\r");
    await firstRun;

    const secondTerminal = new FakeTerminal();
    const calls: string[] = [];
    let recoverPromptCalls = 0;
    const secondRun = new InteractiveTui({
      appDataRoot: root,
      terminal: secondTerminal,
      engine: {
        async *runTurn(input) {
          calls.push(input.prompt);
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "assistant.delta", taskId: input.taskId, text: "safe continuation" };
          yield { type: "turn.completed", taskId: input.taskId };
        },
        async recoverPrompt() {
          recoverPromptCalls += 1;
          return "replay the interrupted operation";
        },
      },
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));

    secondTerminal.emitInput(`:resume ${taskId}`);
    secondTerminal.emitInput("\r");
    const evidence = await waitForOutput(
      secondTerminal,
      new RegExp(
        `${taskId} requires an explicit continuation[\\s\\S]*partial side-effect evidence`,
        "u",
      ),
    );
    assert.match(evidence, /perform the original operation/u);
    assert.equal(calls.length, 0);
    assert.equal(recoverPromptCalls, 0);

    secondTerminal.emitInput(
      `:resume ${taskId} inspect the saved evidence before taking any new action`,
    );
    secondTerminal.emitInput("\r");
    await waitForOutput(secondTerminal, /safe continuation/u);
    assert.deepEqual(calls, ["inspect the saved evidence before taking any new action"]);
    assert.equal(recoverPromptCalls, 0);
    secondTerminal.emitInput(":quit");
    secondTerminal.emitInput("\r");
    await secondRun;
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

test("interactive TUI keeps Auto Git edits in a Task Worktree until reviewed Apply", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-worktree-apply-"));
  const appDataRoot = path.join(root, "app-data");
  const repository = await createTuiGitFixture(root);
  const terminal = new FakeTerminal();
  let executionPath: string | undefined;
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      executionPath = input.cwd;
      await writeFile(path.join(input.cwd, "README.md"), "changed in task\n");
      await writeFile(path.join(input.cwd, "new.txt"), "created in task\n");
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    const runPromise = new InteractiveTui({
      appDataRoot,
      workspacePath: repository,
      engine,
      terminal,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(":profile auto");
    terminal.emitInput("\r");
    terminal.emitInput("edit in isolation");
    terminal.emitInput("\r");
    const created = await waitForOutput(terminal, /Task Worktree:/u);
    const taskId = created.match(/created (task-[a-z0-9]+)/u)?.[1];
    assert.ok(taskId);
    await waitForOutput(terminal, new RegExp(`${taskId} completed`, "u"));
    assert.ok(executionPath?.startsWith(resolveAppPaths(appDataRoot).worktrees));
    assert.notEqual(executionPath, repository);
    assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "base\n");
    assert.equal(existsSync(path.join(repository, "new.txt")), false);

    terminal.emitInput(":apply");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /apply blocked: Review the complete current change list/u);
    assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "base\n");

    terminal.emitInput(":changes");
    terminal.emitInput("\r");
    await waitForOutput(terminal, new RegExp(`changed files: ${taskId}`, "u"));
    terminal.emitInput(":diff");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /\+changed in task/u);
    await waitForOutput(terminal, /\+created in task/u);
    terminal.emitInput(":apply");
    terminal.emitInput("\r");
    await waitForOutput(terminal, new RegExp(`applied ${taskId} to Local Workspace`, "u"));

    assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "changed in task\n");
    assert.equal(await readFile(path.join(repository, "new.txt"), "utf8"), "created in task\n");
    assert.equal(existsSync(executionPath!), false);
    assert.equal(runGit(repository, ["diff", "--cached", "--quiet"]), "");
    const store = new SQLiteTaskStore(
      path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"),
    );
    assert.equal(store.get(taskId)?.worktreePath, undefined);
    store.close();
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI explicitly discards a completed Task Worktree without touching Local", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-worktree-discard-"));
  const appDataRoot = path.join(root, "app-data");
  const repository = await createTuiGitFixture(root);
  const terminal = new FakeTerminal();
  let executionPath: string | undefined;
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      executionPath = input.cwd;
      await writeFile(path.join(input.cwd, "README.md"), "discard me\n");
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    const runPromise = new InteractiveTui({
      appDataRoot,
      workspacePath: repository,
      engine,
      terminal,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput(":profile auto");
    terminal.emitInput("\r");
    terminal.emitInput("edit then discard");
    terminal.emitInput("\r");
    const created = await waitForOutput(terminal, /Task Worktree:/u);
    const taskId = created.match(/created (task-[a-z0-9]+)/u)?.[1];
    assert.ok(taskId);
    await waitForOutput(terminal, new RegExp(`${taskId} completed`, "u"));
    terminal.emitInput(":discard");
    terminal.emitInput("\r");
    await waitForOutput(terminal, new RegExp(`discarded ${taskId}`, "u"));

    assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "base\n");
    assert.equal(existsSync(executionPath!), false);
    assert.equal(runGit(repository, ["status", "--porcelain"]), "");
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive TUI persists reviewed workspace metadata across restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-review-restart-"));
  const appDataRoot = path.join(root, "app-data");
  const repository = await createTuiGitFixture(root);
  const firstTerminal = new FakeTerminal();
  let executionPath: string | undefined;
  const firstEngine: TuiAgentEngine = {
    async *runTurn(input) {
      executionPath = input.cwd;
      await writeFile(path.join(input.cwd, "README.md"), "reviewed after restart\n");
      await writeFile(path.join(input.cwd, "new.txt"), "created after restart\n");
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    const firstRun = new InteractiveTui({
      appDataRoot,
      workspacePath: repository,
      engine: firstEngine,
      terminal: firstTerminal,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    firstTerminal.emitInput(":profile auto");
    firstTerminal.emitInput("\r");
    firstTerminal.emitInput("edit and review after restart");
    firstTerminal.emitInput("\r");
    const created = await waitForOutput(firstTerminal, /Task Worktree:/u);
    const taskId = created.match(/created (task-[a-z0-9]+)/u)?.[1];
    assert.ok(taskId);
    await waitForOutput(firstTerminal, new RegExp(`${taskId} completed`, "u"));
    firstTerminal.emitInput(":changes");
    firstTerminal.emitInput("\r");
    await waitForOutput(firstTerminal, new RegExp(`changed files: ${taskId}`, "u"));
    firstTerminal.emitInput(":diff");
    firstTerminal.emitInput("\r");
    await waitForOutput(firstTerminal, /\+reviewed after restart/u);
    await waitForOutput(firstTerminal, /\+created after restart/u);
    firstTerminal.emitInput(":quit");
    firstTerminal.emitInput("\r");
    await firstRun;

    assert.ok(executionPath);
    assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "base\n");
    assert.equal(existsSync(path.join(repository, "new.txt")), false);

    const secondTerminal = new FakeTerminal();
    let secondEngineCalls = 0;
    const secondEngine: TuiAgentEngine = {
      async *runTurn() {
        yield* [];
        secondEngineCalls += 1;
        throw new Error("review restart unexpectedly started a provider turn");
      },
    };
    const secondRun = new InteractiveTui({
      appDataRoot,
      workspacePath: repository,
      engine: secondEngine,
      terminal: secondTerminal,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    secondTerminal.emitInput(":tasks");
    secondTerminal.emitInput("\r");
    await waitForOutput(secondTerminal, new RegExp(`${taskId}\\tcompleted\\t`, "u"));
    secondTerminal.emitInput(`:use ${taskId}`);
    secondTerminal.emitInput("\r");
    await waitForOutput(secondTerminal, new RegExp(`current task: ${taskId}`, "u"));
    secondTerminal.emitInput(":transcript");
    secondTerminal.emitInput("\r");
    const transcript = await waitForOutput(
      secondTerminal,
      /edit and review after restart[\s\S]*candy_write|edit and review after restart/u,
    );
    assert.match(transcript, /edit and review after restart/u);
    secondTerminal.emitInput(":apply");
    secondTerminal.emitInput("\r");
    await waitForOutput(secondTerminal, new RegExp(`applied ${taskId} to Local Workspace`, "u"));
    assert.equal(secondEngineCalls, 0);
    assert.equal(
      await readFile(path.join(repository, "README.md"), "utf8"),
      "reviewed after restart\n",
    );
    assert.equal(
      await readFile(path.join(repository, "new.txt"), "utf8"),
      "created after restart\n",
    );
    assert.equal(existsSync(executionPath), false);
    assert.equal(runGit(repository, ["diff", "--cached", "--quiet"]), "");
    secondTerminal.emitInput(":quit");
    secondTerminal.emitInput("\r");
    await secondRun;
  } finally {
    await rm(root, { recursive: true, force: true });
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
    let taskId: string | undefined;
    for (let attempt = 0; attempt < 500 && taskId === undefined; attempt += 1) {
      const matches = [...terminal.writes.join("").matchAll(/created (task-[a-z0-9]+)/gu)];
      taskId = matches
        .map((match) => match[1])
        .find((candidate) => candidate !== undefined && !taskIds.includes(candidate));
      if (taskId === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(taskId);
    taskIds.push(taskId);
    await waitForOutput(terminal, new RegExp(`${taskId} completed`, "u"));
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
    const evidenceSummaries = store.list().map((task) => ({
      taskId: task.taskId,
      summary: store.getRun(task.taskId)?.evidenceSummary,
    }));
    assert.ok(
      evidenceSummaries.some(({ summary }) => summary === "validator failed [REDACTED]"),
      JSON.stringify(evidenceSummaries),
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
