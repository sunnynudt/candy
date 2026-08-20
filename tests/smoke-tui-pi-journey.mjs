import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiAgentEngine } from "@candy/pi-adapter";
import { InMemoryCredentialStore, resolveAppPaths, SQLiteTaskStore } from "@candy/platform";
import { InteractiveTui } from "../apps/tui/dist/main.js";
import { FakeTerminal } from "../apps/tui/dist/pi-tui-surface.js";

const root = await mkdtemp(path.join(os.tmpdir(), "candy-tui-pi-journey-"));
const appDataRoot = path.join(root, "app-data");
const workspace = path.join(root, "workspace");
const fixtureSecret = "candy-pi-fixture-secret-8f0b3c6a";
const originalFetch = globalThis.fetch;
const fetchUrls = [];
const terminal = new FakeTerminal();
const credentialStore = new InMemoryCredentialStore();
let stopped = false;

await mkdir(workspace, { recursive: true });
globalThis.fetch = async (input) => {
  fetchUrls.push(String(input));
  return new globalThis.Response(
    'data: {"choices":[{"delta":{"content":"pi fixture response"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

const appPaths = resolveAppPaths(appDataRoot);
const engine = new PiAgentEngine(appPaths.sessions, async () => ({
  secret: fixtureSecret,
  release: () => undefined,
}));
const run = new InteractiveTui({
  appDataRoot,
  workspacePath: workspace,
  terminal,
  credentialStore,
  credentialEnvironment: {},
  engine,
}).run();

try {
  await nextTurn();
  send(terminal, "inspect this Pi fixture");
  const completed = await waitForOutput(terminal, /completed/u);
  assert.match(completed, /pi fixture response/u);
  assert.doesNotMatch(completed, new RegExp(fixtureSecret, "u"));
  send(terminal, ":quit");
  stopped = true;
  await run;

  assert.deepEqual(fetchUrls, ["https://api.deepseek.com/chat/completions"]);
  const store = new SQLiteTaskStore(path.join(appPaths.state, "tasks.sqlite"));
  const tasks = store.list();
  const task = tasks[0];
  assert.ok(task);
  assert.equal(task.state, "completed");
  const transcript = store.transcript(task.taskId);
  store.close();
  assert.ok(transcript?.some((entry) => entry.text.includes("pi fixture response")));

  const sessionFiles = await collectFiles(appPaths.sessions);
  const sessionText = (
    await Promise.all(sessionFiles.map((filePath) => readFile(filePath, "utf8")))
  ).join("\n");
  assert.doesNotMatch(sessionText, new RegExp(fixtureSecret, "u"));
  console.log(
    JSON.stringify({
      piCompatibility: "0.84.1",
      provider: "deepseek",
      approvedEndpoint: true,
      tuiProjection: true,
      sessionPersisted: sessionFiles.length > 0,
      sessionCredentialFree: true,
    }),
  );
} finally {
  if (!stopped) {
    send(terminal, ":quit");
    await run.catch(() => undefined);
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
  throw new Error(`Timed out waiting for Pi-backed TUI output: ${pattern}`);
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
