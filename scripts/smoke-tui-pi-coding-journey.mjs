import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiAgentEngine } from "@candy/pi-adapter";
import { InMemoryCredentialStore, resolveAppPaths } from "@candy/platform";
import { InteractiveTui } from "../apps/tui/dist/main.js";
import { FakeTerminal } from "../apps/tui/dist/pi-tui-surface.js";

const root = await mkdtemp(path.join(os.tmpdir(), "candy-tui-pi-coding-journey-"));
const appDataRoot = path.join(root, "app-data");
const repository = path.join(root, "repository");
const fixtureSecret = "candy-pi-coding-fixture-secret-4d2a9b7c";
const originalFetch = globalThis.fetch;
const fetchUrls = [];
const requestBodies = [];
let activeRun;
let activeTerminal;

await mkdir(repository, { recursive: true });
await writeFile(path.join(repository, "README.md"), "base\n", "utf8");
execFileSync("git", ["init", "-q", repository]);
execFileSync("git", ["-C", repository, "add", "README.md"]);
execFileSync("git", [
  "-C",
  repository,
  "-c",
  "user.name=Candy Fixture",
  "-c",
  "user.email=candy-fixture@example.invalid",
  "commit",
  "-qm",
  "base",
]);
const beforeHead = gitCapture(["-C", repository, "rev-parse", "HEAD"]);

globalThis.fetch = async (input, init) => {
  fetchUrls.push(String(input));
  requestBodies.push(JSON.parse(String(init?.body)));
  if (requestBodies.length === 1) {
    return sseResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_coding_fixture_1",
                  type: "function",
                  function: {
                    name: "candy_write",
                    arguments: JSON.stringify({
                      path: "generated.txt",
                      content: "Pi tool coding fixture\n",
                    }),
                  },
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
  assert.equal(requestBodies.length, 2, "Pi coding fixture must settle after one tool call");
  return sseResponse([
    {
      choices: [
        { delta: { content: "Pi completed the reviewed coding journey." }, finish_reason: null },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
};

const engine = new PiAgentEngine(resolveAppPaths(appDataRoot).sessions, async () => ({
  secret: fixtureSecret,
  release: () => undefined,
}));

try {
  const firstTerminal = new FakeTerminal();
  const firstRun = new InteractiveTui({
    appDataRoot,
    workspacePath: repository,
    terminal: firstTerminal,
    credentialStore: new InMemoryCredentialStore(),
    credentialEnvironment: {},
    engine,
  }).run();
  activeTerminal = firstTerminal;
  activeRun = firstRun;
  await nextTurn();
  send(firstTerminal, ":profile auto");
  await waitForOutput(firstTerminal, /profile auto/u);
  send(firstTerminal, "make and review the requested coding change");
  const completed = await waitForOutput(
    firstTerminal,
    /Pi completed the reviewed coding journey\.[\s\S]*completed/u,
  );
  assert.match(completed, /\[tool candy_write\b/u);
  assert.doesNotMatch(completed, new RegExp(fixtureSecret, "u"));
  const created = completed.match(/created (task-[a-z0-9]+)/u);
  assert.ok(created?.[1]);
  const taskId = created[1];
  send(firstTerminal, ":changes");
  await waitForOutput(
    firstTerminal,
    new RegExp(`changed files: ${taskId}[\\s\\S]*generated\\.txt`, "u"),
  );
  send(firstTerminal, ":diff");
  await waitForOutput(firstTerminal, /\+Pi tool coding fixture/u);
  send(firstTerminal, ":quit");
  await firstRun;
  activeRun = undefined;
  activeTerminal = undefined;

  assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "base\n");
  assert.equal(gitCapture(["-C", repository, "rev-parse", "HEAD"]), beforeHead);
  assert.equal(gitCapture(["-C", repository, "diff", "--cached"]), "");

  const secondTerminal = new FakeTerminal();
  const secondRun = new InteractiveTui({
    appDataRoot,
    workspacePath: repository,
    terminal: secondTerminal,
    engine: {
      async *runTurn() {
        yield* [];
        throw new Error("reopen must not start a new provider turn");
      },
    },
  }).run();
  activeTerminal = secondTerminal;
  activeRun = secondRun;
  await nextTurn();
  send(secondTerminal, ":tasks");
  await waitForOutput(secondTerminal, new RegExp(`${taskId}\\s+completed\\s+`, "u"));
  send(secondTerminal, `:use ${taskId}`);
  await waitForOutput(secondTerminal, new RegExp(`current task: ${taskId}`, "u"));
  send(secondTerminal, ":transcript");
  const transcript = await waitForOutput(
    secondTerminal,
    /make and review the requested coding change[\s\S]*candy_write[\s\S]*Pi completed the reviewed coding journey\./u,
  );
  assert.doesNotMatch(transcript, new RegExp(fixtureSecret, "u"));
  send(secondTerminal, ":apply");
  await waitForOutput(secondTerminal, new RegExp(`applied ${taskId} to Local Workspace`, "u"));
  assert.equal(
    await readFile(path.join(repository, "generated.txt"), "utf8"),
    "Pi tool coding fixture\n",
  );
  assert.equal(gitCapture(["-C", repository, "rev-parse", "HEAD"]), beforeHead);
  assert.equal(gitCapture(["-C", repository, "diff", "--cached"]), "");
  send(secondTerminal, ":quit");
  await secondRun;
  activeRun = undefined;
  activeTerminal = undefined;

  const sessionFiles = await collectFiles(resolveAppPaths(appDataRoot).sessions);
  const persisted = await Promise.all(sessionFiles.map(async (filePath) => readFile(filePath)));
  assert.ok(sessionFiles.length > 0, "Pi session was not persisted");
  for (const content of persisted) assert.equal(content.includes(fixtureSecret), false);
  console.log(
    JSON.stringify({
      piCompatibility: "0.84.1",
      provider: "deepseek",
      codingJourney: "candy_write -> review -> restart -> apply",
      approvedEndpoint: fetchUrls.every(
        (url) => url === "https://api.deepseek.com/chat/completions",
      ),
      providerRequests: fetchUrls.length,
      taskPersisted: true,
      reviewPersistedAcrossRestart: true,
      workspaceMutation: true,
      commitUnchanged: true,
      indexUnchanged: true,
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

function gitCapture(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
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
  throw new Error(`Timed out waiting for Pi coding journey output: ${pattern}`);
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
