import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CommandLedger,
  decodeJsonLine,
  encodeJsonLine,
  EventLedger,
  MAX_JSONL_BYTES,
  ProtocolValidationError,
  validateProtocolMessage,
} from "./index.js";
import { snapshotCommandFixture, snapshotEventFixture } from "./fixtures.js";

test("protocol fixtures round-trip in process", () => {
  assert.deepEqual(decodeJsonLine(encodeJsonLine(snapshotCommandFixture)), snapshotCommandFixture);
  assert.deepEqual(decodeJsonLine(encodeJsonLine(snapshotEventFixture)), snapshotEventFixture);
});

test("protocol fixture round-trips over stdio", async () => {
  const harness = fileURLToPath(new URL("./stdio-harness.js", import.meta.url));
  const child = spawn(process.execPath, [harness], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  child.stdin.end(encodeJsonLine(snapshotCommandFixture));
  const [exitCode] = (await once(child, "exit")) as [number | null];

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(decodeJsonLine(stdout), snapshotCommandFixture);
});

test("invalid versions and malformed input fail closed", () => {
  assert.throws(
    () => validateProtocolMessage({ ...snapshotCommandFixture, v: 2 }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "unsupported_version",
  );
  assert.throws(
    () => decodeJsonLine("not-json"),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "invalid_message",
  );
  assert.throws(
    () =>
      validateProtocolMessage({
        ...snapshotCommandFixture,
        command: { type: "unknown" },
      }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "invalid_message",
  );
  assert.throws(
    () => decodeJsonLine("x".repeat(MAX_JSONL_BYTES + 1)),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "line_too_large",
  );
});

test("secret-shaped fields and values fail closed", () => {
  assert.throws(
    () => validateProtocolMessage({ ...snapshotCommandFixture, apiKey: "redacted" }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "secret_forbidden",
  );
  assert.throws(
    () => validateProtocolMessage({ ...snapshotCommandFixture, note: "Bearer forbidden-value" }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "secret_forbidden",
  );
});

test("duplicate commands and stale revisions fail closed", () => {
  const ledger = new CommandLedger();
  ledger.accept(snapshotCommandFixture, 0);
  assert.throws(
    () => ledger.accept(snapshotCommandFixture, 0),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "duplicate_command",
  );

  const freshLedger = new CommandLedger();
  assert.throws(
    () => freshLedger.accept(snapshotCommandFixture, 1),
    (error: unknown) => error instanceof ProtocolValidationError && error.code === "stale_revision",
  );
});

test("task lifecycle commands and state events remain versioned and secret-free", () => {
  const command = {
    v: 1,
    kind: "command",
    commandId: "create-1",
    taskId: "task-1",
    expectedRevision: 0,
    command: {
      type: "task.create",
      prompt: "inspect fixture",
      approvalProfile: "read-only",
      workspacePath: process.cwd(),
    },
  } as const;
  const event = {
    v: 1,
    kind: "event",
    taskId: "task-1",
    sequence: 1,
    revision: 1,
    event: { type: "task.state_changed", state: "running", reason: "owner_lost" },
  } as const;
  assert.deepEqual(decodeJsonLine(encodeJsonLine(command)), command);
  assert.deepEqual(decodeJsonLine(encodeJsonLine(event)), event);
  assert.throws(
    () =>
      validateProtocolMessage({
        ...command,
        command: {
          type: "task.create",
          prompt: "Bearer canary",
          approvalProfile: "read-only",
          workspacePath: process.cwd(),
        },
      }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "secret_forbidden",
  );
});

test("assistant thinking deltas remain typed and secret-free", () => {
  const event = {
    v: 1,
    kind: "event",
    taskId: "task-thinking",
    sequence: 1,
    revision: 1,
    event: { type: "assistant.thinking.delta", text: "sanitized reasoning fixture" },
  } as const;
  validateProtocolMessage(event);
  assert.deepEqual(decodeJsonLine(encodeJsonLine(event)), event);
});

test("workspace changes remain typed, relative, and secret-free", () => {
  const event = {
    v: 1,
    kind: "event",
    taskId: "task-changes",
    sequence: 1,
    revision: 2,
    event: {
      type: "workspace.changes",
      available: true,
      tracked: ["src/value.ts"],
      untracked: ["notes.txt"],
      patchText: "diff --git a/src/value.ts b/src/value.ts\n",
    },
  } as const;
  assert.deepEqual(decodeJsonLine(encodeJsonLine(event)), event);
  assert.throws(
    () =>
      validateProtocolMessage({
        ...event,
        event: { ...event.event, tracked: ["../outside.ts"] },
      }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "invalid_message",
  );
});

test("event sequencing and snapshot identity fail closed", () => {
  const ledger = new EventLedger();
  ledger.accept(snapshotEventFixture);
  assert.throws(
    () => ledger.accept({ ...snapshotEventFixture, sequence: 3 }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "out_of_sequence",
  );
  assert.throws(
    () =>
      validateProtocolMessage({
        ...snapshotEventFixture,
        event: {
          type: "snapshot",
          snapshot: {
            taskId: "another-task",
            revision: snapshotEventFixture.revision,
            state: "idle",
          },
        },
      }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "invalid_message",
  );
});
