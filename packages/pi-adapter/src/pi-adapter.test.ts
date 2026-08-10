import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CandyPiSessionStore,
  createCandyWorkspaceOperations,
  DeepSeekClient,
  MiniMaxClient,
  MiniMaxPiAgentEngine,
  MODEL_CATALOG,
  PI_COMPATIBILITY_VERSION,
  listPiPublicExports,
  PiAgentEngine,
  parseMiniMaxSseLine,
  parseDeepSeekSseLine,
  ProviderContractError,
} from "./index.js";

test("pinned Pi root SDK export imports under the runtime baseline", () => {
  assert.equal(PI_COMPATIBILITY_VERSION, "0.84.1");
  assert.ok(listPiPublicExports().length > 0);
});

test("provider catalog keeps domestic endpoints and live capabilities gated", () => {
  assert.deepEqual(
    MODEL_CATALOG.map((entry) => [entry.modelId, entry.endpoint, entry.enabled]),
    [
      ["deepseek-v4-flash", "https://api.deepseek.com/chat/completions", false],
      ["deepseek-v4-pro", "https://api.deepseek.com/chat/completions", false],
      ["MiniMax-M3", "https://api.minimaxi.com/anthropic/v1/messages", false],
    ],
  );
});

test("DeepSeek SSE parser projects text and completion without retaining auth", () => {
  assert.deepEqual(parseDeepSeekSseLine('data: {"choices":[{"delta":{"content":"hello"}}]}'), {
    text: "hello",
    done: false,
  });
  assert.deepEqual(parseDeepSeekSseLine("data: [DONE]"), { done: true });
});

test("DeepSeek client uses only the approved endpoint and releases a secret lease", async () => {
  let released = false;
  let request: { input: string; init: RequestInit } | undefined;
  const client = new DeepSeekClient(
    async () => ({ secret: "fixture-secret", release: () => (released = true) }),
    async (input, init) => {
      request = { input, init };
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  const chunks = [];
  for await (const chunk of client.stream(
    { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: true },
    new AbortController().signal,
  ))
    chunks.push(chunk);
  assert.equal(request?.input, "https://api.deepseek.com/chat/completions");
  assert.match(
    String(request?.init.headers && (request.init.headers as Record<string, string>).authorization),
    /^Bearer /u,
  );
  assert.deepEqual(chunks, [{ text: "ok", done: false }, { done: true }]);
  assert.equal(released, true);
});

test("DeepSeek controlled provider failures expose only sanitized reasons", async () => {
  const cases = [
    {
      status: 401,
      reason: "unauthorized",
      transport: async () => new Response(null, { status: 401 }),
    },
    {
      status: 429,
      reason: "rate_limited",
      transport: async () => new Response(null, { status: 429 }),
    },
    {
      status: 0,
      reason: "timeout",
      transport: async () => {
        const error = new Error("fixture timeout with secret fixture-secret");
        error.name = "TimeoutError";
        throw error;
      },
    },
  ] as const;

  for (const fixture of cases) {
    let released = false;
    const client = new DeepSeekClient(
      async () => ({ secret: "fixture-secret", release: () => (released = true) }),
      fixture.transport,
    );
    let caught: unknown;
    try {
      for await (const _delta of client.stream(
        {
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "fixture" }],
          stream: true,
        },
        new AbortController().signal,
      )) {
        // The controlled error must happen before a provider delta is exposed.
        void _delta;
      }
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ProviderContractError);
    assert.equal(caught.code, "provider_error");
    assert.equal(caught.reason, fixture.reason);
    assert.doesNotMatch(caught.message, /fixture-secret/u);
    assert.equal(released, true);
  }
});

test("MiniMax parser and client remain domestic-only and release the secret lease", async () => {
  assert.deepEqual(
    parseMiniMaxSseLine(
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
    ),
    { text: "ok", done: false },
  );
  assert.deepEqual(parseMiniMaxSseLine('data: {"type":"message_stop"}'), { done: true });
  let released = false;
  let request: { input: string; init: RequestInit } | undefined;
  const client = new MiniMaxClient(
    async () => ({ secret: "fixture-secret", release: () => (released = true) }),
    async (input, init) => {
      request = { input, init };
      return new Response(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  const chunks = [];
  for await (const chunk of client.stream(
    {
      model: "MiniMax-M3",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      max_tokens: 32,
      stream: true,
    },
    new AbortController().signal,
  ))
    chunks.push(chunk);
  assert.equal(request?.input, "https://api.minimaxi.com/anthropic/v1/messages");
  assert.deepEqual(chunks, [{ text: "ok", done: false }, { done: true }]);
  assert.equal(released, true);
});

test("Pi agent engine uses public Candy workspace tools and Candy-owned sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-engine-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      'data: {"choices":[{"delta":{"reasoning_content":"thinking","content":"hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  try {
    const observations = [];
    for await (const observation of new PiAgentEngine(root, async () => ({
      secret: "fixture-secret",
      release: () => undefined,
    })).runTurn(
      {
        taskId: "task-1",
        prompt: "say hello",
        model: "deepseek-v4-flash",
        cwd: process.cwd(),
        thinkingLevel: "high",
      },
      new AbortController().signal,
    )) {
      observations.push(observation);
    }
    assert.deepEqual(
      observations.map((observation) => observation.type),
      ["turn.started", "assistant.delta", "assistant.thinking.delta", "turn.completed"],
    );
    const entries = await readdir(path.join(root, "task-1"));
    const sessionFile = entries.find((entry) => entry.endsWith(".jsonl"));
    assert.ok(sessionFile);
    const files = await readFile(path.join(root, "task-1", sessionFile), "utf8");
    assert.doesNotMatch(files, /fixture-secret/u);

    const autoObservations = [];
    for await (const observation of new PiAgentEngine(root, async () => ({
      secret: "fixture-secret",
      release: () => undefined,
    })).runTurn(
      {
        taskId: "task-auto",
        prompt: "say hello",
        model: "deepseek-v4-flash",
        cwd: process.cwd(),
        approvalProfile: "auto",
      },
      new AbortController().signal,
    )) {
      autoObservations.push(observation);
    }
    assert.ok(autoObservations.some((observation) => observation.type === "turn.completed"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pi agent sanitizes provider failures before exposing them to Runtime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-provider-error-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 401 });
  try {
    let caught: unknown;
    try {
      for await (const _observation of new PiAgentEngine(root, async () => ({
        secret: "fixture-secret",
        release: () => undefined,
      })).runTurn(
        {
          taskId: "task-provider-error",
          prompt: "trigger controlled provider error",
          model: "deepseek-v4-flash",
          cwd: process.cwd(),
        },
        new AbortController().signal,
      )) {
        // The provider failure must not become a Runtime observation.
        void _observation;
      }
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ProviderContractError);
    assert.equal(caught.code, "provider_error");
    assert.equal(caught.reason, "unauthorized");
    assert.doesNotMatch(caught.message, /fixture-secret|401/u);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("Candy workspace operations keep Pi edit/write inside the selected directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-workspace-tools-"));
  const outside = await mkdtemp(path.join(tmpdir(), "candy-workspace-outside-"));
  const operations = createCandyWorkspaceOperations(root);
  try {
    await assert.rejects(operations.readFile("relative.txt"), /absolute/u);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
    assert.equal(
      (await operations.readFile(path.join(root, "src", "value.ts"))).toString(),
      "export const value = 1;\n",
    );
    await operations.writeFile(path.join(root, "src", "value.ts"), "export const value = 2;\n");
    await operations.mkdir(path.join(root, "generated", "nested"));
    await assert.rejects(
      operations.readFile(path.join(root, "..", path.basename(outside), "secret.txt")),
      /escaped/u,
    );
    await writeFile(path.join(outside, "secret.txt"), "outside\n");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));
    await assert.rejects(operations.readFile(path.join(root, "linked.txt")), /symbolic/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("MiniMax Pi engine sends image turns through the domestic M3 provider", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-minimax-"));
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return new Response(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"vision"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const observations = [];
    for await (const observation of new MiniMaxPiAgentEngine(root, async () => ({
      secret: "fixture-secret",
      release: () => undefined,
    })).runTurn(
      {
        taskId: "task-vision",
        prompt: "describe the image",
        model: "MiniMax-M3",
        cwd: process.cwd(),
        images: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
      },
      new AbortController().signal,
    )) {
      observations.push(observation);
    }
    assert.equal(requestUrl, "https://api.minimaxi.com/anthropic/v1/messages");
    assert.ok(observations.some((observation) => observation.type === "assistant.delta"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pi session manager persists in Candy-owned storage and reloads with a remapped cwd", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-pi-session-"));
  const store = new CandyPiSessionStore(root);
  const created = await store.create("task-1", "C:/fixture/project");
  const reloaded = await store.reload(created, "/Users/test/project");
  assert.equal(reloaded.sessionFile, created.sessionFile);
  assert.equal(reloaded.sessionId, created.sessionId);
  assert.equal(reloaded.cwd, "/Users/test/project");
  const content = await readFile(created.sessionFile, "utf8");
  assert.ok(CandyPiSessionStore.fingerprint(content).length > 0);
});
