import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CustomPiAgentEngine,
  type ConfiguredModelEntry,
  type PiAgentObservation,
} from "./index.js";

const GLM_ENTRY: ConfiguredModelEntry = {
  id: "glm-4.6",
  label: "GLM-4.6",
  model: "glm-4.6",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  credentialName: "glm",
  apiFormat: "openai",
};

function fixtureLease(): { secret: string; release: () => void } {
  return { secret: "ab", release: () => undefined };
}

test("CustomPiAgentEngine sends turns to the configured OpenAI-compatible endpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-custom-engine-"));
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      'data: {"choices":[{"delta":{"content":"hello from glm"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const observations: PiAgentObservation[] = [];
    for await (const observation of new CustomPiAgentEngine(
      root,
      async () => fixtureLease(),
      GLM_ENTRY,
    ).runTurn(
      {
        taskId: "task-custom-glm",
        prompt: "hi",
        model: "glm-4.6",
        cwd: process.cwd(),
      },
      new AbortController().signal,
    )) {
      observations.push(observation);
    }
    assert.equal(requestUrl, `${GLM_ENTRY.baseUrl}/chat/completions`);
    assert.equal(requestBody?.model, "glm-4.6");
    assert.ok(observations.some((observation) => observation.type === "assistant.delta"));
    assert.ok(observations.some((observation) => observation.type === "turn.completed"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("CustomPiAgentEngine rejects image attachments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-custom-engine-image-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called");
  };
  try {
    await assert.rejects(async () => {
      const engine = new CustomPiAgentEngine(root, async () => fixtureLease(), GLM_ENTRY);
      for await (const observation of engine.runTurn(
        {
          taskId: "task-custom-image",
          prompt: "describe",
          model: "glm-4.6",
          cwd: process.cwd(),
          images: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
        },
        new AbortController().signal,
      )) {
        void observation;
        assert.fail("should not yield observations");
      }
    }, /do not accept image attachments/u);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
