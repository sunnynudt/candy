import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiAgentEngine } from "@candy/pi-adapter";
import { InMemoryCredentialStore, resolveAppPaths, SQLiteTaskStore } from "@candy/platform";
import { InteractiveTui } from "../apps/tui/dist/main.js";
import { FakeTerminal } from "../apps/tui/dist/pi-tui-surface.js";

const root = await mkdtemp(path.join(os.tmpdir(), "candy-tui-pi-cancel-"));
const appDataRoot = path.join(root, "app-data");
const workspace = path.join(root, "workspace");
const fixtureSecret = "candy-pi-cancel-fixture-secret-3b8e2f1a";
const originalFetch = globalThis.fetch;
const fetchUrls = [];
let providerAbortObserved = false;
let activeRun;
let activeTerminal;

await mkdir(workspace, { recursive: true });
globalThis.fetch = async (input, init) => {
  fetchUrls.push(String(input));
  const signal = init?.signal;
  const stream = new globalThis.ReadableStream({
    start(controller) {
      controller.enqueue(
        new globalThis.TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "partial provider output" }, finish_reason: null }] })}\n\n`,
        ),
      );
      signal?.addEventListener(
        "abort",
        () => {
          providerAbortObserved = true;
          controller.error(new Error("fixture provider stream aborted"));
        },
        { once: true },
      );
    },
  });
  return new globalThis.Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

const engine = new PiAgentEngine(resolveAppPaths(appDataRoot).sessions, async () => ({
  secret: fixtureSecret,
  release: () => undefined,
}));

try {
  const terminal = new FakeTerminal();
  const run = new InteractiveTui({
    appDataRoot,
    workspacePath: workspace,
    terminal,
    credentialStore: new InMemoryCredentialStore(),
    credentialEnvironment: {},
    engine,
  }).run();
  activeTerminal = terminal;
  activeRun = run;
  await nextTurn();
  send(terminal, "cancel the provider stream safely");
  const partial = await waitForOutput(terminal, /partial provider output/u);
  const taskId = partial.match(/created (task-[a-z0-9]+)/u)?.[1];
  assert.ok(taskId);
  assert.doesNotMatch(partial, new RegExp(fixtureSecret, "u"));
  send(terminal, `:cancel ${taskId}`);
  const cancelled = await waitForOutput(terminal, new RegExp(`${taskId} cancelled`, "u"));
  assert.doesNotMatch(cancelled, /fixture provider stream aborted/u);
  await waitFor(() => providerAbortObserved);

  const store = new SQLiteTaskStore(path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"));
  const task = store.get(taskId);
  const runMetadata = store.getRun(taskId);
  const transcript = store.transcript(taskId);
  store.close();
  assert.equal(task?.state, "cancelled");
  assert.notEqual(task?.state, "completed");
  assert.ok(runMetadata === undefined || runMetadata.completed === false);
  assert.ok(transcript?.some((entry) => entry.text === "partial provider output"));
  send(terminal, ":quit");
  await run;
  activeRun = undefined;
  activeTerminal = undefined;

  const sessionFiles = await collectFiles(resolveAppPaths(appDataRoot).sessions);
  for (const filePath of sessionFiles) {
    assert.doesNotMatch(await readFile(filePath, "utf8"), new RegExp(fixtureSecret, "u"));
  }
  assert.deepEqual(fetchUrls, ["https://api.deepseek.com/chat/completions"]);
  console.log(
    JSON.stringify({
      provider: "deepseek",
      approvedEndpoint: true,
      providerRequests: fetchUrls.length,
      providerAbortObserved: true,
      taskState: "cancelled",
      falseCompletion: false,
      transcriptPreserved: true,
      sessionCredentialFree: true,
    }),
  );
} finally {
  if (activeRun !== undefined && activeTerminal !== undefined) {
    send(activeTerminal, ":quit");
    await activeRun.catch(() => undefined);
  }
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

function send(terminal, value) {
  terminal.emitInput(value);
  terminal.emitInput("\r");
}

async function nextTurn() {
  await new Promise((resolve) => globalThis.setImmediate(resolve));
}

async function waitForOutput(terminal, pattern) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const output = terminal.writes.join("");
    if (pattern.test(output)) return output;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for Pi cancellation output: ${pattern}`);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for provider abort.");
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}
