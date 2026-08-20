import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiAgentEngine } from "@candy/pi-adapter";
import { InMemoryCredentialStore, resolveAppPaths, SQLiteTaskStore } from "@candy/platform";
import { InteractiveTui } from "../apps/tui/dist/main.js";
import { FakeTerminal } from "../apps/tui/dist/pi-tui-surface.js";

const root = await mkdtemp(path.join(os.tmpdir(), "candy-tui-pi-tool-journey-"));
const appDataRoot = path.join(root, "app-data");
const workspace = path.join(root, "workspace");
const fixtureSecret = "candy-pi-tool-fixture-secret-8f0b3c6a";
const originalFetch = globalThis.fetch;
const requestBodies = [];
const fetchUrls = [];
const terminal = new FakeTerminal();
const credentialStore = new InMemoryCredentialStore();
const appPaths = resolveAppPaths(appDataRoot);
let stopped = false;

await mkdir(workspace, { recursive: true });
globalThis.fetch = async (input, init) => {
  fetchUrls.push(String(input));
  requestBodies.push(JSON.parse(String(init?.body)));
  if (requestBodies.length === 1) {
    const args = JSON.stringify({
      path: "generated.txt",
      content: "Pi tool fixture output\n",
    });
    return sseResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_fixture_1",
                  type: "function",
                  function: { name: "candy_write", arguments: args },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
  }
  assert.equal(requestBodies.length, 2, "Pi tool fixture must settle after one tool call");
  return sseResponse([
    {
      choices: [{ delta: { content: "Pi completed the workspace edit." }, finish_reason: null }],
    },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
};

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
  send(terminal, ":profile auto");
  await waitForOutput(terminal, /profile auto/u);
  send(terminal, "write the requested fixture file");
  const completed = await waitForOutput(terminal, /completed/u);
  assert.match(completed, /\[tool candy_write\b/u);
  assert.match(completed, /Pi completed the workspace edit\./u);
  assert.doesNotMatch(completed, new RegExp(fixtureSecret, "u"));
  assert.equal(
    await readFile(path.join(workspace, "generated.txt"), "utf8"),
    "Pi tool fixture output\n",
  );

  assert.deepEqual(fetchUrls, [
    "https://api.deepseek.com/chat/completions",
    "https://api.deepseek.com/chat/completions",
  ]);
  const firstTools = requestBodies[0].tools;
  assert.ok(Array.isArray(firstTools));
  assert.ok(firstTools.some((tool) => tool.function?.name === "candy_write"));
  assert.ok(requestBodies[1].messages.some((message) => message.role === "tool"));

  send(terminal, ":quit");
  stopped = true;
  await run;

  const store = new SQLiteTaskStore(path.join(appPaths.state, "tasks.sqlite"));
  const task = store.list()[0];
  assert.ok(task);
  assert.equal(task.state, "completed");
  const transcript = store.transcript(task.taskId);
  store.close();
  assert.ok(transcript?.some((entry) => entry.text.includes("Pi completed the workspace edit.")));
  assert.ok(transcript?.some((entry) => entry.text.includes("candy_write")));

  const sessionFiles = await collectFiles(appPaths.sessions);
  const sessionText = (
    await Promise.all(sessionFiles.map((filePath) => readFile(filePath, "utf8")))
  ).join("\n");
  assert.doesNotMatch(sessionText, new RegExp(fixtureSecret, "u"));
  console.log(
    JSON.stringify({
      piCompatibility: "0.84.1",
      provider: "deepseek",
      toolLoop: "candy_write",
      approvedEndpoint: true,
      workspaceMutation: true,
      tuiProjection: true,
      taskPersisted: true,
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

function sseResponse(events) {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new globalThis.Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
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
  throw new Error(`Timed out waiting for Pi-backed TUI tool output: ${pattern}`);
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
