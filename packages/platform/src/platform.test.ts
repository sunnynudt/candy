import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  InMemoryExecutionLeaseRepository,
  LeaseConflictError,
  ManualClock,
  InMemoryCredentialStore,
  resolveCredential,
  SQLiteTaskStore,
  StaleLeaseError,
  cleanChildEnvironment,
  containsCredentialMaterial,
  parseOpenCodeDeepSeekCredential,
  redactCredentialMaterial,
  resolveAppPaths,
  resolveDefaultAppDataRoot,
  type TaskReviewMetadata,
} from "./index.js";

test("credential guard detects and redacts common credential forms", () => {
  const fixtures = [
    "https://user:password-value@example.test/repository",
    "Authorization: Bearer fixture-token-value-123456",
    "github_pat_fixture-token-value-1234567890",
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "private_key: -----BEGIN PRIVATE KEY-----secret-material-----END PRIVATE KEY-----",
    "api_key=fixture-api-key-value",
  ];
  for (const fixture of fixtures) {
    assert.equal(containsCredentialMaterial(fixture), true, fixture);
    assert.doesNotMatch(redactCredentialMaterial(fixture), /fixture-token|password-value|AKIAIOS/u);
  }
  assert.equal(containsCredentialMaterial("ordinary source code token: value"), false);
  assert.doesNotMatch(
    redactCredentialMaterial("fixture-secret", ["fixture-secret"]),
    /fixture-secret/u,
  );
});

test("manual clock advances deterministically", () => {
  const clock = new ManualClock(100);
  clock.advance(50);
  assert.equal(clock.now(), 150);
});

test("execution leases fence expired owners", () => {
  const clock = new ManualClock(1_000);
  const leases = new InMemoryExecutionLeaseRepository(clock, 500);
  const first = leases.acquire("task-1", "owner-1", "nonce-1");

  assert.throws(() => leases.acquire("task-1", "owner-2", "nonce-2"), LeaseConflictError);
  clock.advance(501);
  const second = leases.acquire("task-1", "owner-2", "nonce-2");

  assert.equal(second.generation, first.generation + 1);
  assert.throws(() => leases.heartbeat(first), StaleLeaseError);
  assert.equal(leases.heartbeat(second).ownerId, "owner-2");
});

test("app-data paths are Candy-owned and platform-neutral", () => {
  const paths = resolveAppPaths("Candy Data");
  assert.deepEqual(paths, {
    root: path.resolve("Candy Data"),
    sessions: path.join(path.resolve("Candy Data"), "sessions"),
    attachments: path.join(path.resolve("Candy Data"), "attachments"),
    state: path.join(path.resolve("Candy Data"), "state"),
    browserProfile: path.join(path.resolve("Candy Data"), "browser-profile"),
    worktrees: path.join(path.resolve("Candy Data"), "worktrees"),
  });
});

test("default app-data root uses platform-owned locations", () => {
  assert.equal(
    resolveDefaultAppDataRoot("darwin", {}, "/Users/test"),
    "/Users/test/Library/Application Support/Candy",
  );
  assert.equal(
    resolveDefaultAppDataRoot("win32", { LOCALAPPDATA: "C:/Local" }, "C:/Users/test"),
    path.win32.join("C:/Local", "Candy"),
  );
  assert.equal(resolveDefaultAppDataRoot("linux", {}, "/home/test"), "/home/test/.candy");
});

test("default app-data root honors an explicit Candy-owned override", () => {
  assert.equal(
    resolveDefaultAppDataRoot(
      "win32",
      { CANDY_APP_DATA_ROOT: "D:/Candy Fixture" },
      "C:/Users/test",
    ),
    path.win32.resolve("D:/Candy Fixture"),
  );
  assert.equal(
    resolveDefaultAppDataRoot(
      "darwin",
      { CANDY_APP_DATA_ROOT: "/tmp/candy-fixture" },
      "/Users/test",
    ),
    "/tmp/candy-fixture",
  );
});

test("credential store exposes presence and short-lived leases without renderer readback", () => {
  const credentials = new InMemoryCredentialStore();
  assert.equal(credentials.has("deepseek"), "absent");
  credentials.set("deepseek", "fixture-secret");
  assert.equal(credentials.has("deepseek"), "present");
  assert.equal(credentials.lease("deepseek")?.value, "fixture-secret");
  credentials.replace("deepseek", "replacement");
  credentials.delete("deepseek");
  assert.equal(credentials.has("deepseek"), "absent");
});

test("child environment is allowlisted and removes values containing active secrets", () => {
  const environment = cleanChildEnvironment(
    { PATH: "path", HOME: "home", DEEPSEEK_API_KEY: "fixture-secret", CUSTOM: "ignored" },
    ["fixture-secret"],
  );
  assert.equal(environment.PATH, "path");
  assert.equal(environment.HOME, "home");
  assert.equal(environment.DEEPSEEK_API_KEY, undefined);
  assert.equal(environment.CUSTOM, undefined);
});

test("credential resolution uses only Candy-owned temporary variables before the OS store", () => {
  const store = new InMemoryCredentialStore();
  store.set("deepseek", "os-secret");
  const temporary = resolveCredential(
    "deepseek",
    { CANDY_DEEPSEEK_API_KEY: "temporary-secret", DEEPSEEK_API_KEY: "untrusted-name" },
    store,
  );
  assert.equal(temporary?.value, "temporary-secret");
  temporary?.release();
  assert.equal(resolveCredential("deepseek", {}, store)?.value, "os-secret");
});

test("OpenCode importer accepts only the explicit DeepSeek API entry", () => {
  assert.equal(
    parseOpenCodeDeepSeekCredential({
      deepseek: { type: "api", key: "fixture-opencode-secret" },
      anthropic: { type: "api", key: "other-fixture-secret" },
    }),
    "fixture-opencode-secret",
  );
});

test("OpenCode importer rejects missing, non-API, and invalid DeepSeek entries", () => {
  assert.throws(() => parseOpenCodeDeepSeekCredential({}), /unavailable/iu);
  assert.throws(
    () => parseOpenCodeDeepSeekCredential({ deepseek: { type: "oauth", key: "fixture" } }),
    /unavailable/iu,
  );
  assert.throws(
    () => parseOpenCodeDeepSeekCredential({ deepseek: { type: "api", key: "" } }),
    /invalid/iu,
  );
  assert.throws(
    () => parseOpenCodeDeepSeekCredential({ deepseek: { type: "api", key: "line\nbreak" } }),
    /invalid/iu,
  );
});

test("sqlite task metadata survives restart and fences stale transitions", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-task-store-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const first = new SQLiteTaskStore(databasePath);
    const created = first.create("task-1", "read-only", 4);
    assert.deepEqual(created, {
      taskId: "task-1",
      revision: 0,
      state: "queued",
      approvalProfile: "read-only",
      queueOrder: 4,
      model: "deepseek-v4-flash",
      attachmentIds: [],
      workspacePath: process.cwd(),
      trustedShell: false,
      fullAccess: false,
      pushPolicy: "deny",
      taskMode: "build",
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    });
    const running = first.transition("task-1", 0, "running", "owner-1");
    assert.equal(running.revision, 1);
    const second = new SQLiteTaskStore(databasePath);
    assert.throws(() => second.transition("task-1", 0, "completed"), /stale or missing/);
    second.close();
    first.close();

    const reopened = new SQLiteTaskStore(databasePath);
    assert.deepEqual(reopened.get("task-1"), running);
    assert.equal(reopened.markOwnerInterrupted("owner-1"), 1);
    assert.equal(reopened.get("task-1")?.state, "interrupted");
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite atomically switches model and detaches attachments", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-task-model-attachments-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  const attachmentId = `att_${"a".repeat(64)}`;
  try {
    const store = new SQLiteTaskStore(databasePath);
    const created = store.create("task-model-attachments", "auto", undefined, "MiniMax-M3", [
      attachmentId,
    ]);
    const revised = store.updateApprovalProfile(created.taskId, created.revision, "read-only");

    assert.throws(
      () =>
        store.updateModelAndDetachAttachments(
          created.taskId,
          created.revision,
          "deepseek-v4-flash",
        ),
      /stale or missing/u,
    );
    assert.deepEqual(store.get(created.taskId)?.attachmentIds, [attachmentId]);
    assert.equal(store.get(created.taskId)?.model, "MiniMax-M3");

    const switched = store.updateModelAndDetachAttachments(
      created.taskId,
      revised.revision,
      "deepseek-v4-flash",
    );
    assert.equal(switched.model, "deepseek-v4-flash");
    assert.deepEqual(switched.attachmentIds, []);
    assert.equal(switched.revision, revised.revision + 1);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite task run persists a bounded final evidence summary", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-task-evidence-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const store = new SQLiteTaskStore(databasePath);
    store.create("task-evidence", "auto");
    store.recordRun({
      taskId: "task-evidence",
      rounds: 2,
      evidenceCount: 2,
      completed: true,
      stopReason: "validator_succeeded",
      evidenceSummary: "validator-pass [REDACTED]",
    });
    assert.equal(store.getRun("task-evidence")?.evidenceSummary, "validator-pass [REDACTED]");
    assert.throws(
      () =>
        store.recordRun({
          taskId: "task-evidence",
          rounds: 2,
          evidenceCount: 2,
          completed: true,
          stopReason: "validator_succeeded",
          evidenceSummary: "x".repeat(4_097),
        }),
      /evidence summary/u,
    );
    store.close();

    const reopened = new SQLiteTaskStore(databasePath);
    assert.equal(reopened.getRun("task-evidence")?.evidenceSummary, "validator-pass [REDACTED]");
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite task transcript persists across reopen and rejects invalid entries", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-task-transcript-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const store = new SQLiteTaskStore(databasePath);
    store.create("task-transcript", "auto");
    store.appendTranscript("task-transcript", [
      { role: "user", text: "Fix the failing test." },
      { role: "assistant", text: "I will inspect the workspace." },
      { role: "tool", text: "validator: ok" },
    ]);
    assert.deepEqual(store.transcript("task-transcript"), [
      { role: "user", text: "Fix the failing test." },
      { role: "assistant", text: "I will inspect the workspace." },
      { role: "tool", text: "validator: ok" },
    ]);
    assert.throws(
      () => store.appendTranscript("task-transcript", [{ role: "assistant", text: "a\0b" }]),
      /Transcript entry is invalid/u,
    );
    store.close();

    const reopened = new SQLiteTaskStore(databasePath);
    assert.equal(reopened.transcript("task-transcript")?.length, 3);
    assert.equal(reopened.transcript("task-transcript")?.at(-1)?.text, "validator: ok");
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite task review metadata persists across reopen", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-task-review-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  const review: TaskReviewMetadata = {
    revision: 1,
    changes: {
      available: true,
      tracked: ["src/value.ts"],
      untracked: ["notes.txt"],
      patchText: "diff --git a/src/value.ts b/src/value.ts\n+reviewed\n",
      patchTruncated: false,
    },
    manifestReviewed: true,
    fullDiffReviewed: true,
    untrackedFingerprint: "a".repeat(64),
  };
  try {
    const store = new SQLiteTaskStore(databasePath);
    store.create("task-review", "auto");
    store.updateReview("task-review", review);
    assert.deepEqual(store.getReview("task-review"), review);
    store.close();

    const reopened = new SQLiteTaskStore(databasePath);
    assert.deepEqual(reopened.getReview("task-review"), review);
    reopened.clearReview("task-review");
    assert.equal(reopened.getReview("task-review"), undefined);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite task metadata persists the workspace baseline and never overwrites it", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-task-baseline-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const first = new SQLiteTaskStore(databasePath);
    first.create(
      "task-baseline",
      "auto",
      1,
      "deepseek-v4-flash",
      [],
      process.cwd(),
      undefined,
      "0123456789abcdef",
    );
    assert.equal(first.get("task-baseline")?.workspaceBaseline, "0123456789abcdef");
    first.updateBaseline("task-baseline", "fedcba9876543210");
    assert.equal(first.get("task-baseline")?.workspaceBaseline, "0123456789abcdef");
    first.close();

    const reopened = new SQLiteTaskStore(databasePath);
    assert.equal(reopened.get("task-baseline")?.workspaceBaseline, "0123456789abcdef");
    assert.equal(reopened.updateBaseline("task-baseline").workspaceBaseline, "0123456789abcdef");
    assert.throws(
      () => reopened.create("task-baseline", "auto", 2, "deepseek-v4-flash", [], process.cwd()),
      /UNIQUE constraint|already exists/u,
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite task metadata persists the Task Worktree path and clears it after handoff", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-task-worktree-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  const worktreePath = path.join(directory, "worktrees", "task-wt");
  try {
    const first = new SQLiteTaskStore(databasePath);
    first.create(
      "task-worktree",
      "auto",
      1,
      "deepseek-v4-flash",
      [],
      process.cwd(),
      undefined,
      "0123456789abcdef",
      worktreePath,
    );
    assert.equal(first.get("task-worktree")?.worktreePath, worktreePath);
    first.close();

    const reopened = new SQLiteTaskStore(databasePath);
    assert.equal(reopened.get("task-worktree")?.worktreePath, worktreePath);
    const cleared = reopened.updateWorktree("task-worktree");
    assert.equal(cleared.worktreePath, undefined);
    assert.throws(() => reopened.updateWorktree("task-worktree", "relative/wt"), /absolute/u);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite task metadata reorders queued tasks atomically across restart", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-task-reorder-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const store = new SQLiteTaskStore(databasePath);
    store.create("task-first", "read-only", 1);
    store.create("task-second", "read-only", 2);
    store.create("task-third", "read-only", 3);
    assert.deepEqual(
      store.reorderQueued("task-third", "task-first").map((task) => task.taskId),
      ["task-third", "task-first", "task-second"],
    );
    assert.throws(() => store.reorderQueued("task-third", "task-third"), /itself/u);
    store.close();

    const reopened = new SQLiteTaskStore(databasePath);
    assert.deepEqual(
      reopened.queued().map((task) => [task.taskId, task.queueOrder]),
      [
        ["task-third", 1],
        ["task-first", 2],
        ["task-second", 3],
      ],
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite task metadata persists an explicit Full access decision", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-full-access-task-store-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const store = new SQLiteTaskStore(databasePath);
    const created = store.create(
      "task-full-access",
      "auto",
      undefined,
      undefined,
      [],
      process.cwd(),
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      "build",
      true,
    );
    assert.equal(created.trustedShell, true);
    assert.equal(created.fullAccess, true);
    store.close();

    const reopened = new SQLiteTaskStore(databasePath);
    assert.equal(reopened.get("task-full-access")?.fullAccess, true);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite task store persists the macOS Full access default independently from tasks", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-full-access-preference-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const store = new SQLiteTaskStore(databasePath);
    assert.equal(store.fullAccessDefaultEnabled(), false);
    store.setFullAccessDefaultEnabled(true);
    assert.equal(store.fullAccessDefaultEnabled(), true);
    store.close();

    const reopened = new SQLiteTaskStore(databasePath);
    assert.equal(reopened.fullAccessDefaultEnabled(), true);
    reopened.setFullAccessDefaultEnabled(false);
    assert.equal(reopened.fullAccessDefaultEnabled(), false);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite task store repairs an accepted schema that is missing push policy", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-missing-push-policy-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TABLE task_metadata (
        task_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        approval_profile TEXT NOT NULL,
        queue_order INTEGER,
        owner_id TEXT,
        model_id TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
        attachment_ids TEXT NOT NULL DEFAULT '[]',
        workspace_path TEXT NOT NULL DEFAULT '',
        validator_json TEXT,
        workspace_baseline TEXT,
        worktree_path TEXT,
        trusted_shell INTEGER NOT NULL DEFAULT 0,
        full_access INTEGER NOT NULL DEFAULT 0,
        task_mode TEXT NOT NULL DEFAULT 'build',
        title TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
      INSERT INTO task_metadata (
        task_id,
        revision,
        state,
        approval_profile,
        queue_order,
        model_id,
        attachment_ids,
        workspace_path,
        trusted_shell,
        full_access,
        task_mode
      ) VALUES (
        'task-missing-push-policy',
        0,
        'queued',
        'read-only',
        1,
        'deepseek-v4-flash',
        '[]',
        '',
        0,
        0,
        'build'
      );
      PRAGMA user_version = 17;
    `);
    raw.close();

    const store = new SQLiteTaskStore(databasePath);
    assert.equal(store.get("task-missing-push-policy")?.pushPolicy, "deny");
    assert.deepEqual(
      store.list().map((task) => task.taskId),
      ["task-missing-push-policy"],
    );
    store.close();

    const verified = new DatabaseSync(databasePath);
    const column = verified
      .prepare("SELECT name FROM pragma_table_info('task_metadata') WHERE name = 'push_policy'")
      .get() as { name: string } | undefined;
    assert.equal(column?.name, "push_policy");
    assert.equal(
      (verified.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      17,
    );
    verified.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite task store rejects unknown future schema", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-future-schema-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const raw = new DatabaseSync(databasePath);
    raw.exec("PRAGMA user_version = 14");
    raw.close();
    assert.throws(
      () => new SQLiteTaskStore(databasePath),
      /Unsupported task metadata schema version/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("sqlite task store fails closed on a corrupted database", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-corrupt-db-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    writeFileSync(databasePath, "not a sqlite database file", "utf8");
    assert.throws(
      () => new SQLiteTaskStore(databasePath),
      /not a database|SQLITE_NOTADB|file is not a database/u,
    );
    assert.equal(readFileSync(databasePath, "utf8"), "not a sqlite database file");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("sqlite task data survives file-level backup and restore", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-backup-restore-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  const backupDirectory = path.join(directory, "backup");
  try {
    const store = new SQLiteTaskStore(databasePath);
    store.create("task-backup", "auto", 1);
    store.appendTranscript("task-backup", [{ role: "user", text: "backup fixture" }]);
    store.recordRun({
      taskId: "task-backup",
      rounds: 1,
      evidenceCount: 1,
      completed: true,
      stopReason: "validator_succeeded",
    });
    store.close();

    mkdirSync(backupDirectory, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${databasePath}${suffix}`;
      if (existsSync(source))
        copyFileSync(source, path.join(backupDirectory, `tasks.sqlite${suffix}`));
    }
    const restored = new SQLiteTaskStore(path.join(backupDirectory, "tasks.sqlite"));
    assert.equal(restored.get("task-backup")?.state, "queued");
    assert.equal(restored.transcript("task-backup")?.at(-1)?.text, "backup fixture");
    assert.equal(restored.getRun("task-backup")?.stopReason, "validator_succeeded");
    restored.close();
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("sqlite task store fails closed when storage cannot be opened", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-storage-failure-"));
  const blocked = path.join(directory, "state");
  writeFileSync(blocked, "not a directory", "utf8");
  const databasePath = path.join(blocked, "tasks.sqlite");
  try {
    assert.throws(() => new SQLiteTaskStore(databasePath));
    assert.equal(readFileSync(blocked, "utf8"), "not a directory");
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
