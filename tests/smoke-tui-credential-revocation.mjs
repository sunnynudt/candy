import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiAgentEngine } from "@candy/pi-adapter";
import {
  CANDY_CREDENTIAL_ENV_KEYS,
  InMemoryCredentialStore,
  resolveAppPaths,
  resolveCredential,
  SQLiteTaskStore,
} from "@candy/platform";
import { InteractiveTui } from "../apps/tui/dist/main.js";
import { FakeTerminal } from "../apps/tui/dist/pi-tui-surface.js";

const root = await mkdtemp(path.join(os.tmpdir(), "candy-tui-credential-revocation-"));
const appDataRoot = path.join(root, "app-data");
const workspace = path.join(root, "workspace");
const fixtureSecret = "candy-tui-revocation-fixture-secret-8f0b3c6a";
const environment = {
  [CANDY_CREDENTIAL_ENV_KEYS.deepseek]: fixtureSecret,
};
const originalFetch = globalThis.fetch;
const fetchUrls = [];
const terminal = new FakeTerminal();
const credentialStore = new InMemoryCredentialStore();
const appPaths = resolveAppPaths(appDataRoot);
let stopped = false;

await mkdir(workspace, { recursive: true });
globalThis.fetch = async (input) => {
  fetchUrls.push(String(input));
  return new globalThis.Response(
    'data: {"choices":[{"delta":{"content":"credential-backed fixture response"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

const engine = new PiAgentEngine(appPaths.sessions, async () => {
  const lease = resolveCredential("deepseek", environment, credentialStore);
  return lease === undefined ? undefined : { secret: lease.value, release: lease.release };
});
const run = new InteractiveTui({
  appDataRoot,
  workspacePath: workspace,
  terminal,
  credentialStore,
  credentialEnvironment: environment,
  engine,
}).run();

try {
  await nextTurn();
  send(terminal, ":credential set deepseek");
  await waitForOutput(terminal, /deepseek credential set \(present\)/u);
  send(terminal, "run with the available credential");
  const firstTurn = await waitForOutput(terminal, /completed/u);
  assert.match(firstTurn, /credential-backed fixture response/u);
  assert.doesNotMatch(firstTurn, new RegExp(fixtureSecret, "u"));

  send(terminal, ":credential delete deepseek");
  await waitForOutput(terminal, /deepseek credential deleted/u);
  delete environment[CANDY_CREDENTIAL_ENV_KEYS.deepseek];
  send(terminal, "run after credential deletion");
  const revoked = await waitForOutput(terminal, /provider credentials are unavailable/u);
  assert.doesNotMatch(revoked, new RegExp(fixtureSecret, "u"));
  assert.equal(fetchUrls.length, 1, "missing credentials must not make a provider request");

  send(terminal, ":quit");
  stopped = true;
  await run;

  const store = new SQLiteTaskStore(path.join(appPaths.state, "tasks.sqlite"));
  const task = store.list()[0];
  assert.ok(task);
  assert.equal(task.state, "interrupted");
  const transcript = store.transcript(task.taskId);
  store.close();
  assert.ok(transcript?.some((entry) => entry.text.includes("credential-backed fixture response")));

  const sessionFiles = await collectFiles(appPaths.sessions);
  const sessionText = (
    await Promise.all(sessionFiles.map((filePath) => readFile(filePath, "utf8")))
  ).join("\n");
  assert.doesNotMatch(sessionText, new RegExp(fixtureSecret, "u"));
  console.log(
    JSON.stringify({
      provider: "deepseek",
      initialTurn: "completed",
      deletePresence: "absent",
      revokedTurn: "needs_credentials",
      historyPreserved: true,
      noRequestAfterDelete: true,
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
  throw new Error(`Timed out waiting for credential revocation output: ${pattern}`);
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
