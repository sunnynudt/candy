import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MODEL_CATALOG,
  loadCandyModelConfig,
  loadCandyModelConfigSync,
  resolveModelCatalog,
  validateConfiguredModels,
} from "./index.js";

const VALID_ENTRY = {
  id: "glm-4.6",
  label: "GLM-4.6",
  model: "glm-4.6",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  credentialName: "glm",
  apiFormat: "openai" as const,
};

test("loads a valid models.json into configured entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-model-config-valid-"));
  try {
    await writeFile(
      path.join(root, "models.json"),
      JSON.stringify({ models: [VALID_ENTRY] }),
      "utf8",
    );
    const result = await loadCandyModelConfig(root);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.id, "glm-4.6");
    assert.equal(result.entries[0]?.apiFormat, "openai");
    assert.deepEqual(result.diagnostics, []);
    const syncResult = loadCandyModelConfigSync(root);
    assert.equal(syncResult.entries.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing models.json is a clean empty configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-model-config-missing-"));
  try {
    const result = await loadCandyModelConfig(root);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed JSON with a diagnostic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-model-config-malformed-"));
  try {
    await writeFile(path.join(root, "models.json"), "{ not json", "utf8");
    const result = await loadCandyModelConfig(root);
    assert.deepEqual(result.entries, []);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.kind, "malformed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid entries with diagnostics", () => {
  const result = validateConfiguredModels({
    models: [
      { ...VALID_ENTRY, baseUrl: "http://insecure.example/v1" },
      { ...VALID_ENTRY, apiFormat: "anthropic" },
      { ...VALID_ENTRY, multimodal: true },
      { ...VALID_ENTRY, credentialName: "bad name" },
      { ...VALID_ENTRY, id: "bad id!" },
      { ...VALID_ENTRY, label: "" },
      { ...VALID_ENTRY, baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions" },
    ],
  });
  assert.equal(result.entries.length, 0);
  assert.equal(result.diagnostics.length, 7);
});

test("rejects duplicate configured model ids", () => {
  const result = validateConfiguredModels({
    models: [VALID_ENTRY, VALID_ENTRY],
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.kind, "duplicate-id");
});

test("resolveModelCatalog merges built-in and user-configured entries", () => {
  const catalog = resolveModelCatalog([VALID_ENTRY]);
  assert.equal(catalog.length, MODEL_CATALOG.length + 1);
  const configured = catalog.find((entry) => entry.modelId === "glm-4.6");
  assert.ok(configured);
  assert.equal(configured.gate, "user-configured");
  assert.equal(configured.provider, "glm");
  assert.equal(configured.multimodal, false);
});
