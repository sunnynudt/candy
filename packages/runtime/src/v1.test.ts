import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  NativeProcessRunner,
  ProcessSupervisor,
  ProcessSupervisorUnavailableError,
  SQLiteTaskStore,
} from "@candy/platform";
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
  CommandValidator,
  GitWorktreeManager,
  InMemoryBrowserWorkspace,
  LongRunningTaskRunner,
  MAX_ATTACHMENT_METADATA_BYTES,
  NonGitWorkspaceSnapshotLimitError,
  NonGitWorkspaceChangeTracker,
  ProviderConcurrencyGate,
  SerialMutationLane,
  WorkspaceHandoff,
  isGitWorkspaceClean,
  planGitWorktree,
  resolveGitCommonDirectory,
  resolveTaskWorktreeRoot,
} from "./v1.js";

test("Git common directory is resolved from the original repository seam", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "candy-git-common-"));
  await mkdir(path.join(repository, ".git"));
  const calls: readonly string[][] = [];
  const runner = {
    run: async (args: readonly string[], cwd: string) => {
      (calls as string[][]).push([...args, cwd]);
      return ".git\n";
    },
  };
  assert.equal(
    await resolveGitCommonDirectory(repository, runner),
    await realpath(path.join(repository, ".git")),
  );
  assert.deepEqual(calls, [["rev-parse", "--git-common-dir", repository]]);
});

test("Task Worktree root prefers the project .git directory and falls back otherwise", () => {
  const root = mkdtempSync(path.join(tmpdir(), "candy-worktree-root-"));
  try {
    const repository = path.join(root, "repo");
    mkdirSync(path.join(repository, ".git"), { recursive: true });
    const fallback = path.join(root, "fallback", "worktrees");
    assert.equal(
      resolveTaskWorktreeRoot(repository, fallback),
      path.join(repository, ".git", "candy-worktrees"),
    );

    rmSync(path.join(repository, ".git"), { recursive: true, force: true });
    writeFileSync(path.join(repository, ".git"), "gitdir: /elsewhere/.git\n");
    assert.equal(resolveTaskWorktreeRoot(repository, fallback), fallback);

    rmSync(path.join(repository, ".git"));
    assert.equal(resolveTaskWorktreeRoot(repository, fallback), fallback);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isGitWorkspaceClean detects tracked and untracked changes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "candy-git-clean-"));
  try {
    const repository = path.join(root, "repo");
    mkdirSync(repository);
    execFileSync("git", ["init", "-q"], { cwd: repository });
    writeFileSync(path.join(repository, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Candy Fixture",
        "-c",
        "user.email=candy-fixture@example.invalid",
        "commit",
        "-qm",
        "base",
      ],
      { cwd: repository },
    );
    assert.equal(await isGitWorkspaceClean(repository), true);
    writeFileSync(path.join(repository, "dirty.txt"), "dirty\n");
    assert.equal(await isGitWorkspaceClean(repository), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    const result = await new NativeProcessRunner(runnerPath).run({
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

test("macOS Sandbox Runner rejects provider credentials and keeps them out of the child", async () => {
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
  const root = await mkdtemp(path.join(tmpdir(), "candy-native-env-isolation-"));
  try {
    const providerKey = [
      67, 65, 78, 68, 89, 95, 68, 69, 69, 80, 83, 69, 69, 75, 95, 65, 80, 73, 95, 75, 69, 89,
    ]
      .map((code) => String.fromCharCode(code))
      .join("");
    assert.throws(
      () =>
        new NativeProcessRunner(runnerPath).run({
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: root,
          workspace: root,
          environment: { [providerKey]: "fixture-secret" },
        }),
      /credentials/iu,
    );
    const result = await new NativeProcessRunner(runnerPath).run({
      executable: process.execPath,
      args: [
        "-e",
        "const key = [67,65,78,68,89,95,68,69,69,80,83,69,69,75,95,65,80,73,95,75,69,89].map((code)=>String.fromCharCode(code)).join(''); process.stdout.write(process.env[key] ?? 'absent')",
      ],
      cwd: root,
      workspace: root,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "absent");
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
    const result = await new CommandValidator(new NativeProcessRunner(runnerPath)).run(
      {
        executable: process.execPath,
        args: [
          "-e",
          "process.stdout.write([102,105,120,116,117,114,101,45,115,101,99,114,101,116].map((code)=>String.fromCharCode(code)).join(''))",
        ],
      },
      root,
      new AbortController().signal,
      {},
      ["fixture-secret"],
    );
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
  const metadata = await store.put(
    "image",
    "image/png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  assert.equal(metadata.id.length, 68);
  assert.equal((await store.get(metadata.id)).metadata.sha256, metadata.sha256);
  assert.deepEqual(await store.getImagePayload(metadata.id), {
    id: metadata.id,
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  });
  writeFileSync(path.join(root, `${metadata.id}.bin`), "tampered");
  await assert.rejects(store.get(metadata.id), /integrity/u);
  await assert.rejects(store.put("video", "video/mp4", new Uint8Array([1])), /unavailable/u);
  const outside = path.join(path.dirname(root), "outside.bin");
  writeFileSync(outside, "keep");
  writeFileSync(path.join(root, "evil.json"), JSON.stringify({ id: "../outside", createdAt: 0 }));
  assert.equal(await store.cleanupBefore(101), 1);
  assert.equal(readFileSync(outside, "utf8"), "keep");
  rmSync(outside, { force: true });
});

async function tryCreateFileSymlink(
  t: TestContext,
  target: string,
  linkPath: string,
  reason: string,
): Promise<boolean> {
  try {
    await symlink(target, linkPath);
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip(reason);
      return false;
    }
    throw error;
  }
}

test("attachment store rejects a pre-existing metadata symlink and preserves duplicate puts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-attachment-metadata-link-"));
  const outside = path.join(path.dirname(root), "candy-attachment-metadata-outside.json");
  const content = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  try {
    const store = new AttachmentStore(root, () => 100);
    const first = await store.put("image", "image/png", content);
    const duplicate = await store.put("image", "image/png", content);
    assert.deepEqual(duplicate, first);

    await rm(path.join(root, `${first.id}.json`));
    await writeFile(outside, "keep", "utf8");
    if (
      !(await tryCreateFileSymlink(
        t,
        outside,
        path.join(root, `${first.id}.json`),
        "Windows file symlinks require Developer Mode or equivalent authorization.",
      ))
    )
      return;
    await assert.rejects(store.put("image", "image/png", content), /regular file|integrity/iu);
    assert.equal(await readFile(outside, "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("attachment cleanup bounds metadata materialization", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-attachment-metadata-limit-"));
  const id = `att_${"a".repeat(64)}`;
  try {
    writeFileSync(
      path.join(root, `${id}.json`),
      JSON.stringify({ id, createdAt: 0, padding: "x".repeat(MAX_ATTACHMENT_METADATA_BYTES) }),
    );
    const store = new AttachmentStore(root);
    await assert.rejects(store.cleanupBefore(1), /metadata exceeds/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attachment retrieval bounds metadata and binary materialization", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-attachment-get-limit-"));
  const id = `att_${"b".repeat(64)}`;
  try {
    writeFileSync(
      path.join(root, `${id}.json`),
      JSON.stringify({
        id,
        kind: "image",
        mimeType: "image/png",
        bytes: 1,
        padding: "x".repeat(MAX_ATTACHMENT_METADATA_BYTES),
      }),
    );
    const store = new AttachmentStore(root);
    await assert.rejects(store.get(id), /size limit/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-Git workspace snapshots fail closed at configured aggregate limits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-non-git-snapshot-limit-"));
  try {
    writeFileSync(path.join(root, "one.txt"), "one");
    writeFileSync(path.join(root, "two.txt"), "two");
    const tracker = new NonGitWorkspaceChangeTracker({
      maxDepth: 4,
      maxEntries: 1,
      maxFiles: 2,
      maxBytes: 64,
    });
    await assert.rejects(tracker.captureBaseline(root), NonGitWorkspaceSnapshotLimitError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-Git workspace snapshots do not follow replaced or pre-existing symlink entries", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-non-git-snapshot-links-"));
  const outside = await mkdtemp(path.join(tmpdir(), "candy-non-git-snapshot-links-outside-"));
  try {
    writeFileSync(path.join(outside, "secret.txt"), "outside");
    await mkdir(path.join(outside, "nested"));
    writeFileSync(path.join(outside, "nested", "secret.txt"), "outside nested");
    writeFileSync(path.join(root, "safe.txt"), "inside");
    if (
      !(await tryCreateFileSymlink(
        t,
        path.join(outside, "secret.txt"),
        path.join(root, "linked.txt"),
        "Windows file symlinks require Developer Mode or equivalent authorization.",
      ))
    )
      return;
    await symlink(
      path.join(outside, "nested"),
      path.join(root, "linked-directory"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const tracker = new NonGitWorkspaceChangeTracker();
    await tracker.captureBaseline(root);
    const changes = await tracker.inspect(root);
    assert.deepEqual(changes.tracked, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("attachment store applies a credential guard before persisting bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-attachment-guard-"));
  const store = new AttachmentStore(root, Date.now, () => true);
  try {
    await assert.rejects(
      store.put(
        "image",
        "image/png",
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      ),
      /credential/iu,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attachment store reapplies a credential guard before provider payload retrieval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-attachment-retrieval-guard-"));
  let active = false;
  const store = new AttachmentStore(root, Date.now, () => active);
  try {
    const metadata = await store.put(
      "image",
      "image/png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    active = true;
    await assert.rejects(store.getImagePayload(metadata.id), /credential/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal(store.getRun("debug-task")?.evidenceSummary, "fixture");
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
  assert.equal(
    guard.check({ ...base, paths: ["src/canary.ts"], activeSecrets: ["canary"] }),
    "blocked",
  );
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

test("Git worktree inspection uses an injected Windows path seam on macOS", async () => {
  const plan = planGitWorktree(
    "C:\\repo",
    "C:\\Candy Data\\worktrees\\task-1",
    "task-1",
    "0123456789abcdef",
  );
  const manager = new GitWorktreeManager(
    "C:\\Candy Data\\worktrees",
    {
      run: async () =>
        [
          "worktree C:/Candy Data/worktrees/other",
          "HEAD 0123456789abcdef",
          "locked candy:other",
          "",
          "worktree c:/candy data/worktrees/task-1",
          "HEAD 0123456789abcdef",
          "detached",
          "locked candy:task-1",
          "",
        ].join("\0"),
    },
    path.win32,
  );
  await manager.inspect(plan);

  const wrongLock = new GitWorktreeManager(
    "C:\\Candy Data\\worktrees",
    {
      run: async () =>
        [
          "worktree C:/Candy Data/worktrees/task-1",
          "HEAD 0123456789abcdef",
          "locked candy:other",
          "",
        ].join("\0"),
    },
    path.win32,
  );
  await assert.rejects(wrongLock.inspect(plan), /association/u);
});

test("Git worktree inspection resolves the macOS /var and /private/var aliases", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(path.join(tmpdir(), "candy-git-canonical-"));
  const worktree = path.join(root, "task-worktree");
  mkdirSync(worktree, { recursive: true });
  const plan = planGitWorktree(root, worktree, "task-canonical", "0123456789abcdef");
  const gitReportedPath = worktree.replace(/^\/var(?=\/)/u, "/private/var");
  const manager = new GitWorktreeManager(root, {
    run: async () =>
      [
        `worktree ${gitReportedPath}`,
        "HEAD 0123456789abcdef",
        "detached",
        "locked candy:task-canonical",
        "",
      ].join("\0"),
  });

  try {
    await manager.inspect(plan);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git worktree manager rejects a symlinked parent outside its Candy root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-worktree-boundary-"));
  const worktreeRoot = path.join(root, "worktrees");
  const outside = path.join(root, "outside");
  await mkdir(worktreeRoot);
  await mkdir(outside);
  await symlink(
    outside,
    path.join(worktreeRoot, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const calls: string[][] = [];
  const plan = planGitWorktree(
    path.join(root, "repo"),
    path.join(worktreeRoot, "linked", "task-boundary"),
    "task-boundary",
    "0123456789abcdef",
  );
  const manager = new GitWorktreeManager(worktreeRoot, {
    run: async (args) => {
      calls.push([...args]);
      return "";
    },
  });
  try {
    await assert.rejects(manager.create(plan), /canonical path escaped/u);
    assert.deepEqual(calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git worktree operations recheck containment before running Git", async () => {
  const calls: string[][] = [];
  let canonicalCalls = 0;
  const pathSeam = {
    ...path.win32,
    canonicalize: async (value: string) => {
      canonicalCalls += 1;
      return canonicalCalls === 3 ? "C:\\outside-root" : value;
    },
  };
  const plan = planGitWorktree(
    "C:\\repo",
    "C:\\Candy Data\\worktrees\\task-recheck",
    "task-recheck",
    "0123456789abcdef",
  );
  const manager = new GitWorktreeManager(
    "C:\\Candy Data\\worktrees",
    {
      run: async (args) => {
        calls.push([...args]);
        return "";
      },
    },
    pathSeam,
  );

  await assert.rejects(manager.inspect(plan), /canonical path escaped/u);
  assert.deepEqual(calls, []);
});

test("Git worktree manager rejects a same-path parent replacement during create", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-worktree-identity-"));
  const worktreeRoot = path.join(root, "worktrees");
  const parent = path.join(worktreeRoot, "task-parent");
  const backup = path.join(worktreeRoot, "task-parent-backup");
  await mkdir(parent, { recursive: true });
  let calls = 0;
  const plan = planGitWorktree(
    path.join(root, "repo"),
    path.join(parent, "task-boundary"),
    "task-identity",
    "0123456789abcdef",
  );
  const manager = new GitWorktreeManager(worktreeRoot, {
    run: async () => {
      calls += 1;
      if (calls === 1) {
        await rename(parent, backup);
        await mkdir(parent);
      }
      return "";
    },
  });
  try {
    await assert.rejects(manager.create(plan), /changed while the operation was in progress/u);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git worktree inspection rejects a same-path worktree replacement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-worktree-identity-"));
  const worktreeRoot = path.join(root, "worktrees");
  const worktree = path.join(worktreeRoot, "task-inspect");
  const backup = path.join(worktreeRoot, "task-inspect-backup");
  await mkdir(worktree, { recursive: true });
  let calls = 0;
  const plan = planGitWorktree(
    path.join(root, "repo"),
    worktree,
    "task-identity",
    "0123456789abcdef",
  );
  const manager = new GitWorktreeManager(worktreeRoot, {
    run: async () => {
      calls += 1;
      if (calls === 1) {
        await rename(worktree, backup);
        await mkdir(worktree);
      }
      return [
        `worktree ${worktree}`,
        "HEAD 0123456789abcdef",
        "detached",
        "locked candy:task-identity",
        "",
      ].join("\0");
    },
  });
  try {
    await assert.rejects(manager.inspect(plan), /changed while the operation was in progress/u);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

    writeFileSync(path.join(worktree, "new.txt"), "fixture-active-secret\n");
    await assert.rejects(
      service.apply(worktree, { ...reviewed, activeSecrets: ["fixture-active-secret"] }),
      /active provider credential/u,
    );
    writeFileSync(path.join(worktree, "new.txt"), "untracked\n");

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

test("Apply Changes creates missing untracked parent directories one component at a time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-apply-parent-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await mkdir(source);
  await mkdir(target);
  await mkdir(path.join(source, "nested"));
  await writeFileSync(path.join(source, "nested", "new.txt"), "nested untracked\n");
  const runner = {
    run: async (args: readonly string[]) => {
      if (args[0] === "rev-parse") return "base\n";
      if (args[0] === "status") return "";
      if (args[0] === "ls-files") return "nested/new.txt\n";
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    },
  };
  try {
    await new ApplyChangesService(target, runner).apply(source, {
      targetIsGit: true,
      targetClean: true,
      expectedBase: "base",
      actualBase: "base",
      paths: ["nested/new.txt"],
      untrackedPaths: ["nested/new.txt"],
      patchText: "",
      activeSecrets: [],
    });
    assert.equal(
      await readFile(path.join(target, "nested", "new.txt"), "utf8"),
      "nested untracked\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Apply Changes stops when the target root is replaced between Git commands", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-apply-root-race-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const movedTarget = path.join(root, "target-replaced");
  await mkdir(source);
  await mkdir(target);
  const calls: string[][] = [];
  const runner = {
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "rev-parse") {
        await rename(target, movedTarget);
        await mkdir(target);
        return "base\n";
      }
      if (args[0] === "status") assert.fail("status must not run after the target root changed");
      return "";
    },
  };
  try {
    await assert.rejects(
      new ApplyChangesService(target, runner).apply(source, {
        targetIsGit: true,
        targetClean: true,
        expectedBase: "base",
        actualBase: "base",
        paths: [],
        patchText: "",
        activeSecrets: [],
      }),
      /valid Git target/u,
    );
    assert.deepEqual(calls, [["rev-parse", "HEAD"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
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
