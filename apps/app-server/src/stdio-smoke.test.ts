import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_CONSECUTIVE_INVALID_LINES, runAppServer } from "./main.js";

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

interface StdioHarness {
  readonly stdin: PassThrough;
  readonly output: () => string;
  readonly send: (line: string) => void;
  readonly waitFor: (pattern: RegExp) => Promise<string>;
}

function startStdio(appDataRoot: string): StdioHarness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  runAppServer(stdin, stdout, { appDataRoot });
  return {
    stdin,
    output: () => output,
    send: (line: string) => {
      stdin.write(`${line}\n`);
    },
    waitFor: async (pattern: RegExp): Promise<string> => {
      for (let attempt = 0; attempt < 200 && !pattern.test(output); attempt += 1) await sleep(5);
      return output;
    },
  };
}

const snapshotCommand = (commandId: string): string =>
  JSON.stringify({
    v: 1,
    kind: "command",
    commandId,
    taskId: "task-1",
    expectedRevision: 0,
    command: { type: "snapshot" },
  });

/**
 * In-process equivalent of `npm run smoke:app-server`: the same JSONL command
 * and assertions, without a spawned child, so the check also runs inside
 * environments that clean up long-lived child processes.
 */
test("app-server JSONL stdio loop answers snapshot commands", async () => {
  const appDataRoot = await mkdtemp(path.join(tmpdir(), "candy-app-server-stdio-"));
  const harness = startStdio(appDataRoot);
  try {
    harness.send(snapshotCommand("smoke-1"));
    const first = await harness.waitFor(/"kind":"event"/u);
    assert.match(first, /"kind":"event"/u);
    assert.match(first, /"task-1"/u);
    assert.match(first, /"type":"snapshot"/u);

    harness.send(snapshotCommand("smoke-2"));
    await harness.waitFor(/"commandId"|"sequence":2/u);
    assert.ok((harness.output().match(/"type":"snapshot"/gu) ?? []).length >= 2);
  } finally {
    harness.stdin.end();
    await rm(appDataRoot, { recursive: true, force: true });
  }
});

test("a malformed JSONL line answers with the protocol error envelope", async () => {
  const appDataRoot = await mkdtemp(path.join(tmpdir(), "candy-app-server-stdio-bad-"));
  const harness = startStdio(appDataRoot);
  try {
    harness.send("not-json");
    const output = await harness.waitFor(/"code":"invalid_message"/u);
    assert.match(output, /"kind":"error"/u);
    assert.match(output, /"code":"invalid_message"/u);
  } finally {
    harness.stdin.end();
    await rm(appDataRoot, { recursive: true, force: true });
  }
});

test("the stdio loop keeps serving the commands that follow a malformed line", async () => {
  const appDataRoot = await mkdtemp(path.join(tmpdir(), "candy-app-server-stdio-skip-"));
  const harness = startStdio(appDataRoot);
  try {
    harness.send("not-json");
    await harness.waitFor(/"code":"invalid_message"/u);
    harness.send(snapshotCommand("after-bad-line"));
    const output = await harness.waitFor(/"type":"snapshot"/u);
    assert.match(output, /"kind":"event"/u);
    assert.match(output, /"task-1"/u);
  } finally {
    harness.stdin.end();
    await rm(appDataRoot, { recursive: true, force: true });
  }
});

test("the stdio loop fails closed after a streak of malformed lines", async () => {
  const appDataRoot = await mkdtemp(path.join(tmpdir(), "candy-app-server-stdio-stop-"));
  const harness = startStdio(appDataRoot);
  try {
    for (let index = 0; index < MAX_CONSECUTIVE_INVALID_LINES; index += 1) harness.send("not-json");
    await sleep(100);
    const output = harness.output();
    // One error envelope per malformed line, and nothing beyond that.
    assert.equal((output.match(/"kind":"error"/gu) ?? []).length, MAX_CONSECUTIVE_INVALID_LINES);

    harness.send(snapshotCommand("after-stop"));
    await sleep(100);
    assert.equal(harness.output(), output);
  } finally {
    harness.stdin.end();
    await rm(appDataRoot, { recursive: true, force: true });
  }
});
