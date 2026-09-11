import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CANDY_CREDENTIAL_ENV_KEYS, KeyringCredentialStore } from "@candy/platform";
import { InteractiveTui } from "../apps/tui/dist/main.js";
import { FakeTerminal } from "../apps/tui/dist/pi-tui-surface.js";

const supportedHost =
  (process.platform === "darwin" && process.arch === "arm64") ||
  (process.platform === "win32" && process.arch === "x64");
if (!supportedHost) throw new Error("TUI credential smoke requires macOS arm64 or Windows x64.");

const root = await mkdtemp(path.join(os.tmpdir(), "candy-tui-credentials-"));
const store = new KeyringCredentialStore();
const fixtureValues = {
  one: "candy-tui-credential-fixture-one",
  two: "candy-tui-credential-fixture-two",
};
const before = {
  deepseek: store.has("deepseek"),
  "minimax-cn": store.has("minimax-cn"),
};
const environment = {
  [CANDY_CREDENTIAL_ENV_KEYS.deepseek]: fixtureValues.one,
  [CANDY_CREDENTIAL_ENV_KEYS["minimax-cn"]]: fixtureValues.one,
};
const terminal = new FakeTerminal();
const run = new InteractiveTui({
  appDataRoot: root,
  terminal,
  credentialStore: store,
  credentialEnvironment: environment,
  engine: {
    async *runTurn(input) {
      yield { type: "turn.started", taskId: input.taskId };
      throw new Error("Credential smoke must not start a provider turn.");
    },
  },
}).run();
const mutated = [];
let stopped = false;

try {
  await nextTurn();
  send(terminal, ":credentials");
  const initial = await waitForOutput(terminal, /deepseek: (?:present|absent)/u);
  assert.match(initial, new RegExp(`deepseek: ${before.deepseek}`, "u"));
  assert.match(initial, new RegExp(`minimax-cn: ${before["minimax-cn"]}`, "u"));

  for (const name of ["deepseek", "minimax-cn"]) {
    if (before[name] === "present") continue;
    send(terminal, `:credential set ${name}`);
    await waitForOutput(terminal, new RegExp(`${name} credential set \\(present\\)`, "u"));
    assert.equal(store.has(name), "present");
    mutated.push(name);

    environment[CANDY_CREDENTIAL_ENV_KEYS[name]] = fixtureValues.two;
    send(terminal, `:credential replace ${name}`);
    await waitForOutput(terminal, new RegExp(`${name} credential replace \\(present\\)`, "u"));
    assert.equal(store.has(name), "present");

    send(terminal, `:credential delete ${name}`);
    await waitForOutput(terminal, new RegExp(`${name} credential deleted`, "u"));
    assert.equal(store.has(name), "absent");
    mutated.splice(mutated.indexOf(name), 1);
  }

  const output = terminal.writes.join("");
  assert.doesNotMatch(output, new RegExp(fixtureValues.one, "u"));
  assert.doesNotMatch(output, new RegExp(fixtureValues.two, "u"));
  send(terminal, ":quit");
  stopped = true;
  await run;
  console.log(
    JSON.stringify({
      platform: process.platform,
      architecture: process.arch,
      deepseekBefore: before.deepseek,
      minimaxBefore: before["minimax-cn"],
      tuiPresenceOnly: true,
      completeValuesProjected: false,
      fixtureValuesCleaned: true,
    }),
  );
} finally {
  if (!stopped) {
    send(terminal, ":quit");
    await run.catch(() => undefined);
  }
  for (const name of mutated) {
    if (store.has(name) === "present") store.delete(name);
  }
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
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const output = terminal.writes.join("");
    if (pattern.test(output)) return output;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for TUI credential output: ${pattern}`);
}
