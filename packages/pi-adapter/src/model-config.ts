import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isValidCredentialName } from "@candy/platform";

/**
 * User-configured OpenAI-compatible model entries loaded from the Candy-owned
 * application-data `models.json`. Entries never contain credentials; the
 * credential value lives in the OS store (or the documented temporary
 * environment) under `credentialName`. `baseUrl` is the OpenAI-compatible
 * API root (for example `https://open.bigmodel.cn/api/paas/v4`); the client
 * appends `/chat/completions`.
 */
export interface ConfiguredModelEntry {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly credentialName: string;
  readonly apiFormat: "openai";
}

export interface CandyModelConfigDiagnostic {
  readonly kind:
    "malformed" | "invalid-entry" | "too-large" | "duplicate-id" | "unsupported-format";
  readonly message: string;
}

export interface CandyModelConfigResult {
  readonly entries: readonly ConfiguredModelEntry[];
  readonly diagnostics: readonly CandyModelConfigDiagnostic[];
}

const MAX_MODEL_CONFIG_BYTES = 64 * 1024;
const MAX_MODEL_CONFIG_ENTRIES = 32;
const MAX_MODEL_FIELD_CHARS = 200;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_MODEL_FIELD_CHARS;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  if (containsControlCharacter(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname.length > 0;
}

function validateConfiguredModel(raw: unknown): ConfiguredModelEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.multimodal === "boolean" && candidate.multimodal === true) return undefined;
  const id = candidate.id;
  const label = candidate.label;
  const model = candidate.model;
  const baseUrl = candidate.baseUrl;
  const credentialName = candidate.credentialName;
  const apiFormat = candidate.apiFormat ?? "openai";
  if (typeof id !== "string" || !MODEL_ID_PATTERN.test(id)) return undefined;
  if (!isBoundedText(label)) return undefined;
  if (!isBoundedText(model)) return undefined;
  if (!isHttpsUrl(baseUrl)) return undefined;
  if (typeof credentialName !== "string" || !isValidCredentialName(credentialName))
    return undefined;
  if (apiFormat !== "openai") return undefined;
  if (baseUrl.endsWith("/chat/completions")) return undefined;
  return { id, label, model, baseUrl, credentialName, apiFormat: "openai" };
}

export function validateConfiguredModels(value: unknown): CandyModelConfigResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      entries: [],
      diagnostics: [{ kind: "malformed", message: "models.json must contain a JSON object." }],
    };
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.models === undefined) return { entries: [], diagnostics: [] };
  if (!Array.isArray(candidate.models) || candidate.models.length > MAX_MODEL_CONFIG_ENTRIES) {
    return {
      entries: [],
      diagnostics: [
        {
          kind: "invalid-entry",
          message: `models must be an array with at most ${MAX_MODEL_CONFIG_ENTRIES} entries.`,
        },
      ],
    };
  }
  const entries: ConfiguredModelEntry[] = [];
  const diagnostics: CandyModelConfigDiagnostic[] = [];
  const seen = new Set<string>();
  for (const raw of candidate.models) {
    const entry = validateConfiguredModel(raw);
    if (entry === undefined) {
      diagnostics.push({
        kind: "invalid-entry",
        message:
          "A configured model entry is invalid (id, label, model, https baseUrl API root, credentialName, openai format; baseUrl must not include /chat/completions).",
      });
      continue;
    }
    if (seen.has(entry.id)) {
      diagnostics.push({
        kind: "duplicate-id",
        message: `Duplicate configured model id: ${entry.id}.`,
      });
      continue;
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  return { entries, diagnostics };
}

/**
 * Synchronous variant for TUI startup where the engine composition root must
 * see the configured models before the first task runs.
 */
export function loadCandyModelConfigSync(appDataRoot: string): CandyModelConfigResult {
  const target = path.join(appDataRoot, "models.json");
  if (!existsSync(target)) return { entries: [], diagnostics: [] };
  let content: string;
  try {
    content = readFileSync(target, "utf8");
  } catch (error) {
    return {
      entries: [],
      diagnostics: [{ kind: "malformed", message: `models.json is unreadable: ${String(error)}` }],
    };
  }
  if (Buffer.byteLength(content, "utf8") > MAX_MODEL_CONFIG_BYTES) {
    return {
      entries: [],
      diagnostics: [{ kind: "too-large", message: "models.json exceeds Candy's size limit." }],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      entries: [],
      diagnostics: [{ kind: "malformed", message: "models.json is not valid JSON." }],
    };
  }
  return validateConfiguredModels(parsed);
}

/**
 * Load and validate the Candy-owned models.json. A missing file is a clean
 * empty configuration; a malformed or oversized file produces diagnostics
 * without throwing, so the TUI can keep running with built-in models only.
 */
export async function loadCandyModelConfig(appDataRoot: string): Promise<CandyModelConfigResult> {
  const target = path.join(appDataRoot, "models.json");
  let content: string;
  try {
    content = await readFile(target, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { entries: [], diagnostics: [] };
    return {
      entries: [],
      diagnostics: [{ kind: "malformed", message: `models.json is unreadable: ${String(error)}` }],
    };
  }
  if (Buffer.byteLength(content, "utf8") > MAX_MODEL_CONFIG_BYTES) {
    return {
      entries: [],
      diagnostics: [{ kind: "too-large", message: "models.json exceeds Candy's size limit." }],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      entries: [],
      diagnostics: [{ kind: "malformed", message: "models.json is not valid JSON." }],
    };
  }
  return validateConfiguredModels(parsed);
}
