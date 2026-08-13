import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeepSeekClient,
  MiniMaxClient,
  MiniMaxPiAgentEngine,
  PiAgentEngine,
  ProviderContractError,
} from "@candy/pi-adapter";
import { KeyringCredentialStore } from "@candy/platform";

// Declared before the top-level `await runGate(...)` below: module evaluation
// pauses at that await, so constants used inside `runGate` must be initialized
// first or image turns fail with a TDZ ReferenceError.
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultRoot = path.join(root, "out", "acceptance", "live");
const provider = readArgument("--provider");
const confirmed = process.argv.includes("--confirm-live");

const PROVIDERS = {
  deepseek: {
    envKey: "CANDY_DEEPSEEK_API_KEY",
    host: "https://api.deepseek.com",
  },
  "minimax-cn": {
    envKey: "CANDY_MINIMAX_TOKEN_PLAN_KEY",
    host: "https://api.minimaxi.com",
  },
};

if (!(provider in PROVIDERS) || !confirmed) {
  console.error(
    "Live provider gate is opt-in. Use --provider deepseek|minimax-cn --confirm-live from a private terminal.",
  );
  process.exitCode = 2;
} else {
  process.exitCode = await runGate(provider);
}

async function runGate(selectedProvider) {
  const definition = PROVIDERS[selectedProvider];
  const temporarySecret = process.env[definition.envKey];
  delete process.env.CANDY_DEEPSEEK_API_KEY;
  delete process.env.CANDY_MINIMAX_TOKEN_PLAN_KEY;

  const startedAt = new Date();
  const results = [];
  let temporaryRoot;
  let credentialLease;
  try {
    try {
      credentialLease = new KeyringCredentialStore().lease(selectedProvider);
    } catch {
      credentialLease = undefined;
    }
    const secret = credentialLease?.value ?? temporarySecret;
    if (!secret) {
      results.push({
        id: selectedProvider === "deepseek" ? "LIVE-DS" : "LIVE-MM",
        status: "blocked",
        durationMs: 0,
        summary:
          credentialLease === undefined && temporarySecret === undefined
            ? "approved_credential_not_present"
            : "candy_keychain_unavailable",
      });
      return await finishReport(selectedProvider, startedAt, results, false);
    }

    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "candy-live-provider-"));
    await writeFile(
      path.join(temporaryRoot, "src-value.ts"),
      'export const fixtureValue = "candy-live-read-fixture";\n',
      "utf8",
    );
    const sessionRoot = path.join(temporaryRoot, "sessions");
    let secretReleased = false;
    const acquireSecret = async () => ({
      secret,
      release: () => {
        secretReleased = true;
      },
    });
    const engine =
      selectedProvider === "deepseek"
        ? new PiAgentEngine(sessionRoot, acquireSecret)
        : new MiniMaxPiAgentEngine(sessionRoot, acquireSecret);

    if (selectedProvider === "deepseek") {
      results.push(
        await runScenario(
          "LIVE-DS-01",
          async () =>
            runTurn(engine, {
              taskId: "live-ds-01",
              prompt: "Reply with exactly CANDY_LIVE_DS_OK. Do not call tools.",
              model: "deepseek-v4-flash",
              cwd: temporaryRoot,
            }),
          (outcome) => hasCompletedTextTurn(outcome),
        ),
      );
      results.push(
        await runScenario(
          "LIVE-DS-02",
          async () =>
            runTurn(engine, {
              taskId: "live-ds-02",
              prompt:
                "Use the read tool to inspect src-value.ts, then state the exported fixture value.",
              model: "deepseek-v4-flash",
              cwd: temporaryRoot,
              thinkingLevel: "high",
            }),
          (outcome) => hasCompletedThinkingToolTurn(outcome),
        ),
      );
      results.push(
        await runScenario(
          "LIVE-DS-03",
          async () =>
            runTurn(engine, {
              taskId: "live-ds-03",
              prompt:
                "Use the read tool to inspect src-value.ts, then reply with the fixture value.",
              model: "deepseek-v4-pro",
              cwd: temporaryRoot,
              thinkingLevel: "high",
            }),
          (outcome) => hasCompletedThinkingToolTurn(outcome),
        ),
      );
      results.push(
        await runScenario(
          "LIVE-DS-04-cancel",
          async () =>
            runCancelledTurn(engine, {
              taskId: "live-ds-04",
              prompt: "Write a very long explanation of the fixture and continue until stopped.",
              model: "deepseek-v4-flash",
              cwd: temporaryRoot,
            }),
          (outcome) => outcome.errorClass === "cancelled" && !hasCompleted(outcome),
        ),
      );
      results.push(await runControlledDeepSeekErrorContracts(secret));
    } else {
      results.push(
        await runScenario(
          "LIVE-MM-01",
          async () =>
            runTurn(engine, {
              taskId: "live-mm-01",
              prompt: "Reply with exactly CANDY_LIVE_MM_OK.",
              model: "MiniMax-M3",
              cwd: temporaryRoot,
            }),
          (outcome) => hasCompletedTextTurn(outcome),
        ),
      );
      results.push(
        await runScenario(
          "LIVE-MM-02",
          async () =>
            runTurn(engine, {
              taskId: "live-mm-02",
              prompt: "Describe the attached test image in one short sentence.",
              model: "MiniMax-M3",
              cwd: temporaryRoot,
              images: [{ mimeType: "image/png", data: ONE_PIXEL_PNG }],
            }),
          (outcome) => hasCompletedTextTurn(outcome),
        ),
      );
      results.push(
        await runScenario(
          "LIVE-MM-03",
          async () =>
            runTurn(engine, {
              taskId: "live-mm-03",
              prompt:
                "Use the read tool to inspect src-value.ts, then state the exported fixture value.",
              model: "MiniMax-M3",
              cwd: temporaryRoot,
              thinkingLevel: "high",
            }),
          (outcome) => hasCompletedThinkingToolTurn(outcome),
        ),
      );
      results.push(
        await runScenario(
          "LIVE-MM-04-cancel",
          async () =>
            runCancelledTurn(engine, {
              taskId: "live-mm-04",
              prompt: "Write a very long explanation of the fixture and continue until stopped.",
              model: "MiniMax-M3",
              cwd: temporaryRoot,
            }),
          (outcome) => outcome.errorClass === "cancelled" && !hasCompleted(outcome),
        ),
      );
      results.push(await runControlledMiniMaxErrorContracts(secret));
      results.push({
        id: "LIVE-MM-05",
        status: "blocked",
        durationMs: 0,
        summary: "provider_console_entitlement_confirmation_required",
      });
    }

    results.push({
      id: "secret-free-session",
      status: (await containsValue(temporaryRoot, secret)) ? "fail" : "pass",
      durationMs: 0,
      summary: "session_and_fixture_scan",
    });
    results.push({
      id: "secret-lease-release",
      status: secretReleased ? "pass" : "fail",
      durationMs: 0,
      summary: "provider_lease_lifecycle",
    });
    return await finishReport(selectedProvider, startedAt, results, true);
  } finally {
    credentialLease?.release();
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runScenario(id, execute, accepts) {
  const started = Date.now();
  try {
    const outcome = await execute();
    return {
      id,
      status: accepts(outcome) ? "pass" : "fail",
      durationMs: Date.now() - started,
      summary: summarizeOutcome(outcome),
    };
  } catch (error) {
    return {
      id,
      status: "fail",
      durationMs: Date.now() - started,
      summary: classifyError(error),
    };
  }
}

async function runTurn(engine, input) {
  const observations = [];
  try {
    for await (const observation of engine.runTurn(input, new globalThis.AbortController().signal))
      observations.push(observation);
    return { observations };
  } catch (error) {
    return { observations, errorClass: classifyError(error) };
  }
}

async function runCancelledTurn(engine, input) {
  const controller = new globalThis.AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 250);
  const observations = [];
  try {
    for await (const observation of engine.runTurn(input, controller.signal))
      observations.push(observation);
    return { observations };
  } catch (error) {
    return { observations, errorClass: classifyError(error) };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function runControlledDeepSeekErrorContracts(secret) {
  const started = Date.now();
  const fixtures = [
    { name: "401", status: 401, reason: "unauthorized" },
    { name: "429", status: 429, reason: "rate_limited" },
    { name: "timeout", status: undefined, reason: "timeout" },
  ];
  const outcomes = [];
  for (const fixture of fixtures) {
    let failure = true;
    let leaseReleases = 0;
    let authorizationHeaderMissing = false;
    const client = new DeepSeekClient(
      async () => ({
        secret,
        release: () => {
          leaseReleases += 1;
        },
      }),
      async (_input, init) => {
        if (!new globalThis.Headers(init.headers).has("authorization")) {
          authorizationHeaderMissing = true;
        }
        if (failure) {
          if (fixture.status !== undefined) {
            return new globalThis.Response(null, { status: fixture.status });
          }
          const error = new Error("controlled provider timeout fixture");
          error.name = "TimeoutError";
          throw error;
        }
        return new globalThis.Response(
          'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    );

    let firstError;
    try {
      for await (const delta of client.stream(
        {
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "fixture" }],
          stream: true,
        },
        new globalThis.AbortController().signal,
      )) {
        // The fixture must fail before a provider delta is exposed.
        void delta;
      }
    } catch (error) {
      firstError = error;
    }

    const firstPass =
      firstError instanceof ProviderContractError &&
      firstError.code === "provider_error" &&
      firstError.reason === fixture.reason &&
      !firstError.message.includes(secret);
    failure = false;
    let recovered = false;
    try {
      const deltas = [];
      for await (const delta of client.stream(
        {
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "recovery" }],
          stream: true,
        },
        new globalThis.AbortController().signal,
      )) {
        deltas.push(delta);
      }
      recovered = deltas.some((delta) => delta.text === "recovered");
    } catch {
      // The failed recovery attempt is reflected by the default false value.
    }
    outcomes.push({
      name: fixture.name,
      pass: firstPass && recovered && !authorizationHeaderMissing && leaseReleases === 2,
      recovered,
    });
  }

  const summary = outcomes
    .map((outcome) => `${outcome.name}=${outcome.pass ? "pass" : "fail"}`)
    .join(",");
  const recovery = outcomes.every((outcome) => outcome.recovered) ? "verified" : "failed";
  return {
    id: "LIVE-DS-04-error-contracts",
    status: outcomes.every((outcome) => outcome.pass) ? "pass" : "fail",
    durationMs: Date.now() - started,
    summary: `${summary}; recovery=${recovery}; credential=not_in_error_or_fixture`,
  };
}

async function runControlledMiniMaxErrorContracts(secret) {
  const started = Date.now();
  const fixtures = [
    { name: "401", status: 401, reason: "unauthorized" },
    { name: "429", status: 429, reason: "rate_limited" },
    { name: "timeout", status: undefined, reason: "timeout" },
  ];
  const outcomes = [];
  for (const fixture of fixtures) {
    let failure = true;
    let leaseReleases = 0;
    let authorizationHeaderMissing = false;
    const client = new MiniMaxClient(
      async () => ({
        secret,
        release: () => {
          leaseReleases += 1;
        },
      }),
      async (_input, init) => {
        if (!new globalThis.Headers(init.headers).has("authorization")) {
          authorizationHeaderMissing = true;
        }
        if (failure) {
          if (fixture.status !== undefined) {
            return new globalThis.Response(null, { status: fixture.status });
          }
          const error = new Error("controlled provider timeout fixture");
          error.name = "TimeoutError";
          throw error;
        }
        return new globalThis.Response(
          [
            "event: message_start",
            'data: {"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
            "",
            "event: content_block_start",
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
            "",
            "event: content_block_delta",
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"recovered"}}',
            "",
            "event: content_block_stop",
            'data: {"type":"content_block_stop","index":0}',
            "",
            "event: message_delta",
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
            "",
            "event: message_stop",
            'data: {"type":"message_stop"}',
            "",
            "",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    );

    let firstError;
    try {
      for await (const delta of client.stream(
        {
          model: "MiniMax-M3",
          messages: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
          max_tokens: 16,
          stream: true,
        },
        new globalThis.AbortController().signal,
      )) {
        // The fixture must fail before a provider delta is exposed.
        void delta;
      }
    } catch (error) {
      firstError = error;
    }

    const firstPass =
      firstError instanceof ProviderContractError &&
      firstError.code === "provider_error" &&
      firstError.reason === fixture.reason &&
      !firstError.message.includes(secret);
    failure = false;
    let recovered = false;
    try {
      const deltas = [];
      for await (const delta of client.stream(
        {
          model: "MiniMax-M3",
          messages: [{ role: "user", content: [{ type: "text", text: "recovery" }] }],
          max_tokens: 16,
          stream: true,
        },
        new globalThis.AbortController().signal,
      )) {
        deltas.push(delta);
      }
      recovered = deltas.some((delta) => delta.text === "recovered");
    } catch {
      // The failed recovery attempt is reflected by the default false value.
    }
    outcomes.push({
      name: fixture.name,
      pass: firstPass && recovered && !authorizationHeaderMissing && leaseReleases === 2,
      recovered,
    });
  }

  const summary = outcomes
    .map((outcome) => `${outcome.name}=${outcome.pass ? "pass" : "fail"}`)
    .join(",");
  const recovery = outcomes.every((outcome) => outcome.recovered) ? "verified" : "failed";
  return {
    id: "LIVE-MM-04-error-contracts",
    status: outcomes.every((outcome) => outcome.pass) ? "pass" : "fail",
    durationMs: Date.now() - started,
    summary: `${summary}; recovery=${recovery}; credential=not_in_error_or_fixture`,
  };
}

function hasCompleted(outcome) {
  return outcome.observations.some((observation) => observation.type === "turn.completed");
}

function hasCompletedTextTurn(outcome) {
  return (
    hasCompleted(outcome) &&
    outcome.observations.some((observation) => observation.type === "assistant.delta")
  );
}

function hasCompletedToolTurn(outcome) {
  return (
    hasCompletedTextTurn(outcome) &&
    outcome.observations.some((observation) => observation.type === "tool.started") &&
    outcome.observations.some(
      (observation) => observation.type === "tool.completed" && observation.ok,
    )
  );
}

function hasCompletedThinkingToolTurn(outcome) {
  return (
    hasCompletedToolTurn(outcome) &&
    outcome.observations.some((observation) => observation.type === "assistant.thinking.delta")
  );
}

function summarizeOutcome(outcome) {
  return [
    ...new Set(outcome.observations.map((observation) => observation.type)),
    ...(outcome.errorClass === undefined ? [] : [`error:${outcome.errorClass}`]),
  ].join(",");
}

function classifyError(error) {
  if (error && typeof error.code === "string" && /^[a-z_]+$/u.test(error.code)) return error.code;
  if (error instanceof Error && /cancel/u.test(error.message)) return "cancelled";
  return "provider_error";
}

async function containsValue(directory, value) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && (await containsValue(entryPath, value))) return true;
    if (entry.isFile() && (await readFile(entryPath, "utf8")).includes(value)) return true;
  }
  return false;
}

async function finishReport(selectedProvider, startedAt, results, credentialPresent) {
  const definition = PROVIDERS[selectedProvider];
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status === "fail").length;
  const blocked = results.filter((result) => result.status === "blocked").length;
  const report = [
    `# Candy live ${selectedProvider} provider gate`,
    "",
    `- Started: ${startedAt.toISOString()}`,
    `- Source revision: \`${readGitRevision()}\``,
    `- Provider: \`${selectedProvider}\``,
    `- Approved host: \`${definition.host}\``,
    `- Credential presence: \`${credentialPresent ? "present" : "absent"}\``,
    "- Credential value, length, fingerprint, headers, prompts, and raw provider payloads are intentionally absent.",
    "",
    `Summary: ${passed} passed, ${failed} failed, ${blocked} blocked.`,
    "",
    "| Test | Status | Duration | Sanitized summary |",
    "| --- | --- | ---: | --- |",
    ...results.map(
      (result) =>
        `| \`${result.id}\` | ${result.status} | ${result.durationMs} ms | ${result.summary} |`,
    ),
    "",
    "A live provider gate is Pass only when every mandatory test is Pass and the external entitlement/platform evidence is attached separately.",
    "",
  ].join("\n");
  await mkdir(resultRoot, { recursive: true });
  await writeFile(path.join(resultRoot, `${selectedProvider}-latest.md`), report, "utf8");
  console.log(`live provider report: out/acceptance/live/${selectedProvider}-latest.md`);
  if (failed > 0) return 1;
  if (blocked > 0) return 2;
  return 0;
}

function readGitRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
