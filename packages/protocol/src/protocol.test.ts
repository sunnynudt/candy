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
          snapshot: { ...snapshotEventFixture.event.snapshot, taskId: "another-task" },
        },
      }),
    (error: unknown) =>
      error instanceof ProtocolValidationError && error.code === "invalid_message",
  );
});
