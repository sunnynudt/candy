import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CandyPiSessionStore,
  DeepSeekClient,
  MODEL_CATALOG,
  PI_COMPATIBILITY_VERSION,
  listPiPublicExports,
  parseDeepSeekSseLine,
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
