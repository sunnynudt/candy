import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SQLiteTaskStore } from "@candy/platform";
import {
  ApplyChangesService,
  ApplyChangesGuard,
  AttachmentStore,
  ApprovalPolicy,
  BrowserControlError,
  BrowserRevisionError,
  FixedValidator,
  GitWorkspaceChangeTracker,
  LongRunningControlError,
  MacSandboxRunner,
  MacSandboxValidator,
  GitWorktreeManager,
  InMemoryBrowserWorkspace,
  LongRunningTaskRunner,
  ProviderConcurrencyGate,
  ProcessSupervisor,
  ProcessSupervisorUnavailableError,
  SerialMutationLane,
  WorkspaceHandoff,
  planGitWorktree,
} from "./v1.js";

test("approval policy keeps read-only strict and shell unavailable before native G2", () => {
  const readOnly = new ApprovalPolicy("read-only");
  assert.equal(
    readOnly.decide({
      kind: "workspace.read",
      network: false,
      destructive: false,
      outsideWorkspace: false,
      mutable: false,
    }),
    "allow",
  );
  assert.equal(
    readOnly.decide({
      kind: "workspace.write",
      network: false,
      destructive: false,
      outsideWorkspace: false,
      mutable: true,
    }),
    "deny",
  );
  assert.equal(
    readOnly.decide({
      kind: "shell",
      network: false,
      destructive: false,
      outsideWorkspace: false,
      mutable: true,
    }),
    "unsupported",
  );
  const auto = new ApprovalPolicy("auto");
  assert.equal(
    auto.decide({
      kind: "shell",
      network: false,
      destructive: false,
      outsideWorkspace: false,
      mutable: true,
    }),
    "unsupported",
  );
  assert.equal(
    auto.decide({
      kind: "git.publish",
      network: true,
      destructive: false,
      outsideWorkspace: false,
      mutable: true,
    }),
    "require_approval",
  );
});

test("mutation lane serializes writes and provider gates are independent", async () => {
  const lane = new SerialMutationLane();
  const order: string[] = [];
  await Promise.all([
    lane.run(async () => {
      order.push("a-start");
      await Promise.resolve();
      order.push("a-end");
    }),
    lane.run(async () => {
      order.push("b-start");
      order.push("b-end");
    }),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  const deepseek = new ProviderConcurrencyGate("deepseek", 1);
  let release!: () => void;
  const first = deepseek.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const second = deepseek.run(async () => "second");
  await Promise.resolve();
  assert.equal(deepseek.active, 1);
  release();
  await first;
  assert.equal(await second, "second");
});

test("process supervisor is shell-free, strips provider env, and keeps Windows gated", async () => {
  assert.throws(
    () =>
      new ProcessSupervisor("win32").run({
        executable: process.execPath,
        args: [],
        cwd: process.cwd(),
      }),
    ProcessSupervisorUnavailableError,
  );
  assert.throws(
    () =>
      new ProcessSupervisor("darwin").run({
        executable: process.execPath,
        args: [],
        cwd: process.cwd(),
        environment: { CANDY_DEEPSEEK_API_KEY: "fixture-secret" },
      }),
    /credentials/iu,
  );
  const result = await new ProcessSupervisor("darwin").run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(process.env.CUSTOM ? 'present' : 'clean')"],
    cwd: process.cwd(),
    environment: { CUSTOM: "fixture-secret" },
    activeSecrets: ["fixture-secret"],
  });
  assert.equal(result.stdout, "clean");
});

test("macOS Sandbox Runner executes a no-network validator through the native boundary", async () => {
  if (process.platform !== "darwin") return;
  const runnerPath = path.join(
    process.cwd(),
    "native",
    "sandbox-runner",
    "target",
    "debug",
    "candy-sandbox-runner",
  );
  if (!existsSync(runnerPath)) return;
  const root = await mkdtemp(path.join(tmpdir(), "candy-native-validator-"));
  try {
    const result = await new MacSandboxRunner(runnerPath).run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('validator-ok')"],
      cwd: root,
      workspace: root,
      environment: { CUSTOM: "fixture" },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "validator-ok");
    assert.equal(result.cancelled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS Sandbox Validator returns bounded secret-redacted evidence", async () => {
  if (process.platform !== "darwin") return;
  const runnerPath = path.join(
    process.cwd(),
    "native",
    "sandbox-runner",
    "target",
    "debug",
    "candy-sandbox-runner",
  );
  if (!existsSync(runnerPath)) return;
  const root = await mkdtemp(path.join(tmpdir(), "candy-native-validator-evidence-"));
  try {
    const result = await new MacSandboxValidator(
      new MacSandboxRunner(runnerPath),
      root,
      {
        executable: process.execPath,
        args: [
          "-e",
          "process.stdout.write([102,105,120,116,117,114,101,45,115,101,99,114,101,116].map((code)=>String.fromCharCode(code)).join(''))",
        ],
      },
      {},
      ["fixture-secret"],
    ).run(new AbortController().signal);
    assert.equal(result.ok, true);
    assert.equal(result.evidence, "[REDACTED]");
    assert.doesNotMatch(result.fingerprint, /fixture-secret/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attachment store hashes image bytes, keeps binary outside session, and rejects video", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-attachments-"));
  const store = new AttachmentStore(root, () => 100);
  const metadata = await store.put("image", "image/png", new TextEncoder().encode("image-fixture"));
  assert.equal(metadata.id.length, 68);
  assert.equal((await store.get(metadata.id)).metadata.sha256, metadata.sha256);
  assert.deepEqual(await store.getImagePayload(metadata.id), {
    id: metadata.id,
    mimeType: "image/png",
    data: Buffer.from("image-fixture").toString("base64"),
  });
  writeFileSync(path.join(root, `${metadata.id}.bin`), "tampered");
  await assert.rejects(store.get(metadata.id), /integrity/u);
  await assert.rejects(store.put("video", "video/mp4", new Uint8Array([1])), /unavailable/u);
  assert.equal(await store.cleanupBefore(101), 1);
});

test("browser state rejects stale revisions, disallowed sites, sensitive actions, and honors Take Control", () => {
  const browser = new InMemoryBrowserWorkspace();
  const tab = browser.open("https://fixture.invalid");
  assert.throws(
    () => browser.act(tab.tabId, { type: "click", target: "#x", expectedRevision: 1 }),
    BrowserControlError,
  );
  browser.allowSite("fixture.invalid");
  const allowed = browser.open("https://fixture.invalid");
  assert.throws(
    () => browser.act(allowed.tabId, { type: "click", target: "#x", expectedRevision: 0 }),
    BrowserRevisionError,
  );
  assert.throws(
    () =>
      browser.act(allowed.tabId, {
        type: "submit",
        target: "#x",
        expectedRevision: allowed.revision,
        confirmed: false,
      }),
    BrowserControlError,
  );
  const user = browser.takeControl(allowed.tabId);
  assert.equal(user.control, "user");
  assert.throws(
    () =>
      browser.act(allowed.tabId, { type: "click", target: "#x", expectedRevision: user.revision }),
    BrowserControlError,
  );
});

test("long-running tasks complete only on validator success and stop stalled evidence", async () => {
  const signal = new AbortController().signal;
  const failing = new FixedValidator({
    ok: false,
    fingerprint: "same",
    evidence: "fail",
    durationMs: 1,
  });
  const stalled = await new LongRunningTaskRunner(5, 2).run(async () => undefined, failing, signal);
  assert.deepEqual(stalled.stopReason, "stall_detected");
  const successResult = { ok: true, fingerprint: "pass", evidence: "pass", durationMs: 1 } as const;
  const success = new FixedValidator(successResult);
  const completed = await new LongRunningTaskRunner(5).run(async () => undefined, success, signal);
  assert.deepEqual(completed, {
    completed: true,
    stopReason: "validator_succeeded",
    rounds: 1,
    evidence: [successResult],
  });
});

test("long-running validator progress persists only bounded evidence metadata", async () => {
  const store = new SQLiteTaskStore(":memory:");
  store.create("debug-task", "read-only");
  const result = { ok: true, fingerprint: "pass", evidence: "fixture", durationMs: 1 } as const;
  const completed = await new LongRunningTaskRunner(3).run(
    async () => undefined,
    new FixedValidator(result),
    new AbortController().signal,
    {
      store: {
        record: (progress) => store.recordRun({ taskId: "debug-task", ...progress }),
      },
    },
  );
  assert.equal(completed.stopReason, "validator_succeeded");
  assert.equal(store.getRun("debug-task")?.completed, true);
  assert.equal(store.getRun("debug-task")?.evidenceCount, 1);
  assert.match(store.getRun("debug-task")?.lastFingerprintHash ?? "", /^[a-f0-9]{64}$/u);
  store.close();
});

test("long-running control stops preserve distinct approval, ownership, provider, and user reasons", async () => {
  for (const stopReason of [
    "approval_required",
    "ownership_lost",
    "provider_failure",
    "user_stop",
  ] as const) {
    const result = await new LongRunningTaskRunner(3).run(
      async () => {
        throw new LongRunningControlError(stopReason);
      },
      new FixedValidator({ ok: false, fingerprint: "unused", evidence: "unused", durationMs: 0 }),
      new AbortController().signal,
    );
    assert.equal(result.stopReason, stopReason);
  }
});

test("Apply Changes guard fails closed for dirty, changed-base, escaped, and secret-containing patches", () => {
  const guard = new ApplyChangesGuard("C:/workspace");
  const base = {
    targetIsGit: true,
    targetClean: true,
    expectedBase: "a",
    actualBase: "a",
    paths: ["src/a.ts"],
    patchText: "safe",
    activeSecrets: [],
  } as const;
  assert.equal(guard.check(base), "allow");
  assert.equal(guard.check({ ...base, targetClean: false }), "blocked");
  assert.equal(guard.check({ ...base, actualBase: "b" }), "blocked");
  assert.equal(guard.check({ ...base, paths: ["../secret"] }), "blocked");
  assert.equal(guard.check({ ...base, patchText: "canary", activeSecrets: ["canary"] }), "blocked");
});

test("Apply Changes guard and worktree planning cover the Windows path matrix", () => {
  const guard = new ApplyChangesGuard("C:\\Users\\alice\\repo", path.win32);
  const base = {
    targetIsGit: true,
    targetClean: true,
    expectedBase: "a",
    actualBase: "a",
    paths: ["src/a.ts"],
    patchText: "safe",
    activeSecrets: [],
  } as const;
  assert.equal(guard.check(base), "allow");
  assert.equal(guard.check({ ...base, paths: ["..\\secret.ts"] }), "blocked");
  assert.equal(guard.check({ ...base, paths: ["src\\..\\..\\secret.ts"] }), "blocked");
  assert.equal(guard.check({ ...base, paths: ["C:\\secret.ts"] }), "blocked");
  assert.equal(guard.check({ ...base, paths: ["\\\\server\\share\\secret.ts"] }), "blocked");
  assert.equal(guard.check({ ...base, paths: ["src\\with space.ts"] }), "allow");
  assert.equal(guard.check({ ...base, targetClean: false }), "blocked");
  assert.equal(guard.check({ ...base, actualBase: "b" }), "blocked");

  const plan = planGitWorktree(
    "C:\\Users\\alice\\repo",
    "C:\\Candy Data\\worktrees\\task-1",
    "task-1",
    "0123456789abcdef",
  );
  assert.deepEqual(plan.createArgs, [
    "worktree",
    "add",
    "--detach",
    "--lock",
    "--reason",
    "candy:task-1",
    "C:\\Candy Data\\worktrees\\task-1",
    "0123456789abcdef",
  ]);
  assert.throws(() => planGitWorktree("C:\\repo", "C:\\wt", "task\\1", "0123456"), /Task id/u);
  assert.throws(
    () => planGitWorktree("C:\\repo", "C:\\wt", "task-1", "not-a-commit"),
    /commit id/u,
  );
});

test("Git worktree planning uses argument arrays and handoff blocks unsafe transfer", () => {
  const plan = planGitWorktree(
    "C:/repo",
    "C:/Candy Data/worktrees/task-1",
    "task-1",
    "0123456789abcdef",
  );
  assert.deepEqual(plan.createArgs, [
    "worktree",
    "add",
    "--detach",
    "--lock",
    "--reason",
    "candy:task-1",
    "C:/Candy Data/worktrees/task-1",
    "0123456789abcdef",
  ]);
  assert.throws(() => planGitWorktree("repo", "worktree", "task/1", "0123456"), /Task id/u);
  const handoff = new WorkspaceHandoff();
  handoff.startWorktree();
  handoff.beginApply("blocked");
  assert.equal(handoff.state, "blocked");
});

test("Git worktree inspection parses NUL porcelain records and requires the matching lock", async () => {
  const plan = planGitWorktree(
    "C:\\repo",
    "C:\\Candy Data\\worktrees\\task-1",
    "task-1",
    "0123456789abcdef",
  );
  const manager = new GitWorktreeManager("C:\\Candy Data\\worktrees", {
    run: async () =>
      [
        "worktree C:/Candy Data/worktrees/other",
        "HEAD 0123456789abcdef",
        "locked candy:other",
        "",
        "worktree C:/Candy Data/worktrees/task-1",
        "HEAD 0123456789abcdef",
        "detached",
        "locked candy:task-1",
        "",
      ].join("\0"),
  });
  await manager.inspect(plan);

  const wrongLock = new GitWorktreeManager("C:\\Candy Data\\worktrees", {
    run: async () =>
      [
        "worktree C:/Candy Data/worktrees/task-1",
        "HEAD 0123456789abcdef",
        "locked candy:other",
        "",
      ].join("\0"),
  });
  await assert.rejects(wrongLock.inspect(plan), /association/u);
});

test("Git worktree fixture creates, inspects, and cleans a detached task worktree", () => {
  const root = mkdtempSync(path.join(tmpdir(), "candy-git-fixture-"));
  const repository = path.join(root, "repo");
  const worktree = path.join(root, "task-worktree");
  mkdirSync(repository);
  const git = (args: readonly string[], cwd: string): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  try {
    git(["init", "-q"], repository);
    writeFileSync(path.join(repository, "README.md"), "fixture\n");
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
    const baseCommit = git(["rev-parse", "HEAD"], repository).trim();
    const plan = planGitWorktree(repository, worktree, "task-fixture", baseCommit);

    git(plan.createArgs, repository);
    assert.equal(existsSync(path.join(worktree, "README.md")), true);
    assert.match(git(plan.inspectArgs, repository), /candy:task-fixture/u);
    git(plan.unlockArgs, repository);
    git(plan.removeArgs, repository);
    assert.equal(existsSync(worktree), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git worktree discard resets and removes a dirty task worktree", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "candy-git-discard-"));
  const repository = path.join(root, "repo");
  const worktree = path.join(root, "worktrees", "task-worktree");
  mkdirSync(repository);
  const git = (args: readonly string[], cwd: string): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  try {
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
    const baseCommit = git(["rev-parse", "HEAD"], repository).trim();
    const plan = planGitWorktree(repository, worktree, "task-discard", baseCommit);
    const manager = new GitWorktreeManager(path.join(root, "worktrees"));
    await manager.create(plan);
    writeFileSync(path.join(worktree, "README.md"), "reviewed\n");
    writeFileSync(path.join(worktree, "new.txt"), "untracked\n");

    await manager.discard(plan);
    assert.equal(existsSync(worktree), false);
    assert.equal(git(["worktree", "list", "--porcelain"], repository).includes(worktree), false);
    assert.equal(git(["status", "--porcelain"], repository), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Apply Changes service stops on dirty target, changed base, conflict, and untracked collision", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "candy-git-apply-matrix-"));
  const repository = path.join(root, "repo");
  const worktree = path.join(root, "worktrees", "task-worktree");
  mkdirSync(repository);
  const git = (args: readonly string[], cwd: string): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  try {
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
    const baseCommit = git(["rev-parse", "HEAD"], repository).trim();
    const plan = planGitWorktree(repository, worktree, "task-matrix", baseCommit);
    const manager = new GitWorktreeManager(path.join(root, "worktrees"));
    await manager.create(plan);
    writeFileSync(path.join(worktree, "README.md"), "changed\n");
    writeFileSync(path.join(worktree, "new.txt"), "untracked\n");
    const service = new ApplyChangesService(repository);
    const reviewed = {
      targetIsGit: true,
      targetClean: true,
      expectedBase: baseCommit,
      actualBase: baseCommit,
      paths: ["README.md", "new.txt"],
      untrackedPaths: ["new.txt"],
      patchText: git(
        ["diff", "--binary", "--no-ext-diff", "--no-color", baseCommit, "--"],
        worktree,
      ),
      activeSecrets: [],
    } as const;

    writeFileSync(path.join(repository, "README.md"), "dirty local\n");
    await assert.rejects(service.apply(worktree, reviewed), /blocked/iu);
    git(["checkout", "--", "README.md"], repository);

    writeFileSync(path.join(repository, "README.md"), "next base\n");
    git(["add", "README.md"], repository);
    git(
      [
        "-c",
        "user.name=Candy Fixture",
        "-c",
        "user.email=candy-fixture@example.invalid",
        "commit",
        "-qm",
        "next",
      ],
      repository,
    );
    await assert.rejects(service.apply(worktree, reviewed), /blocked/iu);
    git(["reset", "--hard", "-q", baseCommit], repository);

    const conflictingPatch =
      "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,2 @@\n base\n+extra\n";
    await assert.rejects(
      service.apply(worktree, {
        ...reviewed,
        paths: ["README.md"],
        untrackedPaths: [],
        patchText: conflictingPatch,
      }),
      /refused the reviewed patch/u,
    );

    const target = path.join(root, "target");
    git(["clone", "-q", repository, target], root);
    await appendFile(path.join(target, ".git", "info", "exclude"), "new.txt\n");
    writeFileSync(path.join(target, "new.txt"), "already here\n");
    await assert.rejects(
      new ApplyChangesService(target).apply(worktree, reviewed),
      /untracked Apply Changes path/u,
    );
    assert.equal(existsSync(path.join(target, "new.txt")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git changes are reviewed and applied without changing the target index", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-apply-"));
  const repository = path.join(root, "repo");
  const worktreeRoot = path.join(root, "worktrees");
  const worktree = path.join(worktreeRoot, "task-apply");
  mkdirSync(repository);
  const git = (args: readonly string[], cwd: string): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git(["init", "-q"], repository);
    writeFileSync(path.join(repository, "README.md"), "base\n");
    writeFileSync(path.join(repository, "binary.bin"), Buffer.from([0, 1, 2]));
    git(["add", "."], repository);
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
    const baseCommit = git(["rev-parse", "HEAD"], repository).trim();
    const plan = planGitWorktree(repository, worktree, "task-apply", baseCommit);
    const manager = new GitWorktreeManager(worktreeRoot);
    await manager.create(plan);
    writeFileSync(path.join(worktree, "README.md"), "changed fixture-secret\n");
    writeFileSync(path.join(worktree, "binary.bin"), Buffer.from([0, 1, 3]));
    writeFileSync(path.join(worktree, "new.txt"), "untracked\n");
    const tracker = new GitWorkspaceChangeTracker();
    assert.equal(await tracker.captureBaseline(worktree), baseCommit);
    const reviewed = await tracker.inspect(worktree, baseCommit, ["fixture-secret"]);
    assert.equal(reviewed.available, true);
    assert.equal(reviewed.patchTruncated, false);
    assert.equal(reviewed.patchText.includes("fixture-secret"), false);
    assert.match(reviewed.patchText, /\[REDACTED\]/u);
    const changes = await manager.changes(plan);
    assert.deepEqual(changes.tracked, ["README.md", "binary.bin"]);
    assert.deepEqual(changes.untracked, ["new.txt"]);

    const service = new ApplyChangesService(repository);
    assert.equal(
      await service.apply(worktree, {
        targetIsGit: true,
        targetClean: true,
        expectedBase: baseCommit,
        actualBase: baseCommit,
        paths: [...changes.tracked, ...changes.untracked],
        patchText: changes.patchText,
        activeSecrets: [],
      }),
      "applied",
    );
    assert.equal(
      await readFile(path.join(repository, "README.md"), "utf8"),
      "changed fixture-secret\n",
    );
    assert.deepEqual([...(await readFile(path.join(repository, "binary.bin")))], [0, 1, 3]);
    assert.equal(await readFile(path.join(repository, "new.txt"), "utf8"), "untracked\n");
    assert.equal(git(["diff", "--cached", "--quiet"], repository), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-root Apply verifies the reviewed diff and untracked manifest without touching the index", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-same-root-apply-"));
  const repository = path.join(root, "repo");
  mkdirSync(repository);
  const git = (args: readonly string[], cwd: string): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
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
    const baseCommit = git(["rev-parse", "HEAD"], repository).trim();
    writeFileSync(path.join(repository, "README.md"), "reviewed\n");
    writeFileSync(path.join(repository, "new.txt"), "untracked\n");
    const tracker = new GitWorkspaceChangeTracker();
    const reviewed = await tracker.inspect(repository, baseCommit, []);
    assert.equal(reviewed.available, true);
    assert.equal(reviewed.patchTruncated, false);

    const service = new ApplyChangesService(repository);
    assert.equal(
      await service.apply(repository, {
        targetIsGit: true,
        targetClean: true,
        expectedBase: baseCommit,
        actualBase: baseCommit,
        paths: [...reviewed.tracked, ...reviewed.untracked],
        untrackedPaths: reviewed.untracked,
        patchText: reviewed.patchText,
        activeSecrets: [],
      }),
      "applied",
    );
    assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "reviewed\n");
    assert.equal(await readFile(path.join(repository, "new.txt"), "utf8"), "untracked\n");
    assert.equal(git(["diff", "--cached", "--quiet"], repository), "");

    writeFileSync(path.join(repository, "README.md"), "changed after review\n");
    await assert.rejects(
      service.apply(repository, {
        targetIsGit: true,
        targetClean: true,
        expectedBase: baseCommit,
        actualBase: baseCommit,
        paths: [...reviewed.tracked, ...reviewed.untracked],
        untrackedPaths: reviewed.untracked,
        patchText: reviewed.patchText,
        activeSecrets: [],
      }),
      /changed before Apply/u,
    );
    assert.equal(git(["diff", "--cached", "--quiet"], repository), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
