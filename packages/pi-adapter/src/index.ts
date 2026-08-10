import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as piSdk from "@earendil-works/pi-coding-agent";

export const PI_COMPATIBILITY_VERSION = "0.84.1" as const;

export function listPiPublicExports(): readonly string[] {
  return Object.keys(piSdk).sort();
}

export type CandyProvider = "deepseek" | "minimax-cn";

export interface ModelCatalogEntry {
  readonly label: string;
  readonly provider: CandyProvider;
  readonly modelId: string;
  readonly endpoint: string;
  readonly multimodal: boolean;
  readonly enabled: boolean;
  readonly gate: "live-provider" | "static-contract";
}

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    label: "DeepSeek V4 Flash",
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    endpoint: "https://api.deepseek.com/chat/completions",
    multimodal: false,
    enabled: false,
    gate: "live-provider",
  },
  {
    label: "DeepSeek V4 Pro",
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    endpoint: "https://api.deepseek.com/chat/completions",
    multimodal: false,
    enabled: false,
    gate: "live-provider",
  },
  {
    label: "MiniMax M3",
    provider: "minimax-cn",
    modelId: "MiniMax-M3",
    endpoint: "https://api.minimaxi.com/anthropic/v1/messages",
    multimodal: true,
    enabled: false,
    gate: "live-provider",
  },
];

export class ProviderContractError extends Error {
  public constructor(
    message: string,
    public readonly code:
      "needs_credentials" | "unapproved_endpoint" | "malformed_stream" | "provider_error",
  ) {
    super(message);
    this.name = "ProviderContractError";
  }
}

export interface DeepSeekMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
}

export interface DeepSeekTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface DeepSeekRequest {
  readonly model: "deepseek-v4-flash" | "deepseek-v4-pro";
  readonly messages: readonly DeepSeekMessage[];
  readonly tools?: readonly DeepSeekTool[];
  readonly stream: true;
}

export interface DeepSeekDelta {
  readonly text?: string;
  readonly toolCall?: {
    readonly name: string;
    readonly arguments: string;
  };
  readonly done: boolean;
}

export interface MiniMaxMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly (
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "image";
        readonly source: {
          readonly type: "base64";
          readonly media_type: string;
          readonly data: string;
        };
      }
  )[];
}

export interface MiniMaxRequest {
  readonly model: "MiniMax-M3";
  readonly messages: readonly MiniMaxMessage[];
  readonly max_tokens: number;
  readonly stream: true;
}

export interface MiniMaxDelta {
  readonly text?: string;
  readonly thinking?: string;
  readonly done: boolean;
}

export type SecretLease = { readonly secret: string; readonly release: () => void };
export type SecretLeaseProvider = () => Promise<SecretLease | undefined>;
export type HttpTransport = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The provider boundary is deliberately small. It owns the approved host,
 * request shape, SSE parsing, and the short-lived secret lease. It does not
 * expose credentials to the Runtime or to tool execution.
 */
export class DeepSeekClient {
  public constructor(
    private readonly acquireSecret: SecretLeaseProvider,
    private readonly transport: HttpTransport = fetch,
  ) {}

  public async *stream(
    request: DeepSeekRequest,
    signal: AbortSignal,
  ): AsyncIterable<DeepSeekDelta> {
    const model = MODEL_CATALOG.find(
      (entry) => entry.provider === "deepseek" && entry.modelId === request.model,
    );
    if (!model || model.endpoint !== "https://api.deepseek.com/chat/completions") {
      throw new ProviderContractError("DeepSeek model is not approved.", "unapproved_endpoint");
    }

    const lease = await this.acquireSecret();
    if (!lease) {
      throw new ProviderContractError("DeepSeek credentials are unavailable.", "needs_credentials");
    }

    let response: Response;
    try {
      response = await this.transport(model.endpoint, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${lease.secret}`,
        },
        body: JSON.stringify(request),
        signal,
      });
    } finally {
      lease.release();
    }

    if (!response.ok || !response.body) {
      throw new ProviderContractError(
        `DeepSeek request failed with HTTP ${response.status}.`,
        "provider_error",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const delta = parseDeepSeekSseLine(line);
          if (delta) yield delta;
        }
        if (chunk.done) break;
      }
      if (pending.trim()) {
        const delta = parseDeepSeekSseLine(pending);
        if (delta) yield delta;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/** Domestic-only MiniMax M3 contract. There is intentionally no fallback URL. */
export class MiniMaxClient {
  public constructor(
    private readonly acquireSecret: SecretLeaseProvider,
    private readonly transport: HttpTransport = fetch,
  ) {}

  public async *stream(request: MiniMaxRequest, signal: AbortSignal): AsyncIterable<MiniMaxDelta> {
    if (request.model !== "MiniMax-M3" || request.max_tokens <= 0) {
      throw new ProviderContractError(
        "MiniMax model request is not approved.",
        "unapproved_endpoint",
      );
    }
    const lease = await this.acquireSecret();
    if (!lease) {
      throw new ProviderContractError("MiniMax credentials are unavailable.", "needs_credentials");
    }

    let response: Response;
    try {
      response = await this.transport("https://api.minimaxi.com/anthropic/v1/messages", {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${lease.secret}`,
        },
        body: JSON.stringify(request),
        signal,
      });
    } finally {
      lease.release();
    }
    if (!response.ok || !response.body) {
      throw new ProviderContractError(
        `MiniMax request failed with HTTP ${response.status}.`,
        "provider_error",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const delta = parseMiniMaxSseLine(line);
          if (delta) yield delta;
        }
        if (chunk.done) break;
      }
      if (pending.trim()) {
        const delta = parseMiniMaxSseLine(pending);
        if (delta) yield delta;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export function parseMiniMaxSseLine(line: string): MiniMaxDelta | undefined {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("data:")) return undefined;
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "[DONE]") return { done: true };
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new ProviderContractError("MiniMax emitted malformed SSE JSON.", "malformed_stream");
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ProviderContractError("MiniMax emitted an invalid event.", "malformed_stream");
  }
  if (value.type === "message_stop") return { done: true };
  if (value.type === "content_block_delta" && isRecord(value.delta)) {
    const text = typeof value.delta.text === "string" ? value.delta.text : undefined;
    const thinking = typeof value.delta.thinking === "string" ? value.delta.thinking : undefined;
    return {
      ...(text === undefined ? {} : { text }),
      ...(thinking === undefined ? {} : { thinking }),
      done: false,
    };
  }
  return { done: false };
}

export function parseDeepSeekSseLine(line: string): DeepSeekDelta | undefined {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("data:")) return undefined;
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "[DONE]") return { done: true };
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new ProviderContractError("DeepSeek emitted malformed SSE JSON.", "malformed_stream");
  }
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw new ProviderContractError(
      "DeepSeek emitted an invalid choices payload.",
      "malformed_stream",
    );
  }
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.delta)) {
    throw new ProviderContractError(
      "DeepSeek emitted an invalid delta payload.",
      "malformed_stream",
    );
  }
  const text = typeof first.delta.content === "string" ? first.delta.content : undefined;
  return text === undefined ? { done: false } : { text, done: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PiSessionHandle {
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly cwd: string;
}

type PiMessage = Parameters<piSdk.SessionManager["appendMessage"]>[0];

/** Candy-owned session location using Pi's documented SessionManager export. */
export class CandyPiSessionStore {
  public constructor(private readonly sessionRoot: string) {}

  public async create(taskId: string, cwd: string): Promise<PiSessionHandle> {
    const directory = path.join(this.sessionRoot, taskId);
    await mkdir(directory, { recursive: true });
    const manager = piSdk.SessionManager.create(cwd, directory);
    manager.appendCustomEntry("candy.session.created", { taskId });
    manager.appendMessage({
      role: "user",
      content: "Candy Runtime proof session",
      timestamp: Date.now(),
    } satisfies PiMessage);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Session initialized." }],
      api: "openai-completions",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } satisfies PiMessage);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("Pi did not create a persisted session file.");
    return { sessionFile, sessionId: manager.getSessionId(), cwd };
  }

  public async reload(handle: PiSessionHandle, remappedCwd: string): Promise<PiSessionHandle> {
    const content = await readFile(handle.sessionFile, "utf8");
    if (!content.includes('"type":"session"')) {
      throw new Error("Candy session does not contain a Pi session header.");
    }
    const manager = piSdk.SessionManager.open(
      handle.sessionFile,
      path.dirname(handle.sessionFile),
      remappedCwd,
    );
    return {
      sessionFile: handle.sessionFile,
      sessionId: manager.getSessionId(),
      cwd: remappedCwd,
    };
  }

  public static fingerprint(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }
}

export interface PiEngineInput {
  readonly taskId: string;
  readonly prompt: string;
  readonly model: "deepseek-v4-flash" | "deepseek-v4-pro";
}

export type PiEngineObservation =
  | { readonly type: "turn.started"; readonly taskId: string }
  | { readonly type: "assistant.delta"; readonly taskId: string; readonly text: string }
  | { readonly type: "turn.completed"; readonly taskId: string };

/**
 * Runtime-facing proof engine. Pi owns the session format; the provider client
 * owns the approved HTTP contract. No Pi types cross this interface.
 */
export class PiProofEngine {
  public constructor(private readonly client: DeepSeekClient) {}

  public async *runTurn(
    input: PiEngineInput,
    signal: AbortSignal,
  ): AsyncIterable<PiEngineObservation> {
    yield { type: "turn.started", taskId: input.taskId };
    for await (const delta of this.client.stream(
      { model: input.model, messages: [{ role: "user", content: input.prompt }], stream: true },
      signal,
    )) {
      if (delta.text) yield { type: "assistant.delta", taskId: input.taskId, text: delta.text };
    }
    yield { type: "turn.completed", taskId: input.taskId };
  }
}

export interface PiAgentEngineInput {
  readonly taskId: string;
  readonly prompt: string;
  readonly model: "deepseek-v4-flash" | "deepseek-v4-pro";
  readonly cwd: string;
}

export type PiAgentObservation =
  | { readonly type: "turn.started"; readonly taskId: string }
  | { readonly type: "assistant.delta"; readonly taskId: string; readonly text: string }
  | { readonly type: "tool.started"; readonly taskId: string; readonly tool: string }
  | {
      readonly type: "tool.completed";
      readonly taskId: string;
      readonly tool: string;
      readonly ok: boolean;
    }
  | { readonly type: "turn.completed"; readonly taskId: string };

/**
 * Pi-backed runtime path. Only the documented coding-agent root SDK is used;
 * Pi owns the loop, read tool, stream and Candy-owned session JSONL.
 */
export class PiAgentEngine {
  public constructor(
    private readonly sessionRoot: string,
    private readonly acquireSecret: SecretLeaseProvider,
  ) {}

  public async *runTurn(
    input: PiAgentEngineInput,
    signal: AbortSignal,
  ): AsyncIterable<PiAgentObservation> {
    const lease = await this.acquireSecret();
    if (!lease)
      throw new ProviderContractError("DeepSeek credentials are unavailable.", "needs_credentials");
    const sessionDirectory = path.join(this.sessionRoot, input.taskId);
    await mkdir(sessionDirectory, { recursive: true });
    const credentialStore = new PiCredentialStore(lease.secret);
    let session: piSdk.AgentSession | undefined;
    try {
      const modelRuntime = await piSdk.ModelRuntime.create({
        credentials: credentialStore,
        modelsPath: null,
        refreshOnCreate: false,
      });
      const model = modelRuntime.getModel("deepseek", input.model);
      if (!model)
        throw new ProviderContractError("DeepSeek model is not available.", "provider_error");
      const existing = (await piSdk.SessionManager.listAll(sessionDirectory)).sort(
        (left, right) => right.modified.getTime() - left.modified.getTime(),
      )[0];
      const sessionManager = existing
        ? piSdk.SessionManager.open(existing.path, sessionDirectory, input.cwd)
        : piSdk.SessionManager.create(input.cwd, sessionDirectory);
      const created = await piSdk.createAgentSession({
        cwd: input.cwd,
        agentDir: path.join(this.sessionRoot, "pi-agent"),
        modelRuntime,
        model,
        sessionManager,
        tools: ["read"],
      });
      session = created.session;
      const events = new AsyncEventQueue<piSdk.AgentSessionEvent>();
      const unsubscribe = session.subscribe((event) => events.push(event));
      const abort = (): void => session?.agent.abort();
      signal.addEventListener("abort", abort, { once: true });
      let promptError: unknown;
      const promptPromise = session.prompt(input.prompt).catch((error: unknown) => {
        promptError = error;
        events.fail(new Error("Pi agent turn failed."));
      });
      let started = false;
      try {
        for (;;) {
          const event = await events.next();
          if (event.done) break;
          if (event.value.type === "agent_start" && !started) {
            started = true;
            yield { type: "turn.started", taskId: input.taskId };
          } else if (
            event.value.type === "message_update" &&
            event.value.assistantMessageEvent.type === "text_delta"
          ) {
            yield {
              type: "assistant.delta",
              taskId: input.taskId,
              text: event.value.assistantMessageEvent.delta,
            };
          } else if (event.value.type === "tool_execution_start") {
            yield { type: "tool.started", taskId: input.taskId, tool: event.value.toolName };
          } else if (event.value.type === "tool_execution_end") {
            yield {
              type: "tool.completed",
              taskId: input.taskId,
              tool: event.value.toolName,
              ok: !event.value.isError,
            };
          } else if (event.value.type === "agent_end") {
            await promptPromise;
            if (promptError !== undefined) throw new Error("Pi agent turn failed.");
            break;
          }
        }
      } finally {
        unsubscribe();
        signal.removeEventListener("abort", abort);
      }
      if (signal.aborted) throw new Error("Pi agent turn cancelled.");
      yield { type: "turn.completed", taskId: input.taskId };
    } finally {
      session?.dispose();
      credentialStore.clear();
      lease.release();
    }
  }
}

type PiCredentialStoreContract = NonNullable<
  NonNullable<Parameters<typeof piSdk.ModelRuntime.create>[0]>["credentials"]
>;
type PiCredential = Awaited<ReturnType<PiCredentialStoreContract["read"]>>;
type PiCredentialInfo = Awaited<ReturnType<PiCredentialStoreContract["list"]>>[number];
type PiCredentialModifier = Parameters<PiCredentialStoreContract["modify"]>[1];

class PiCredentialStore implements PiCredentialStoreContract {
  #secret: string | undefined;

  public constructor(secret: string) {
    this.#secret = secret;
  }

  public async read(providerId: string): Promise<PiCredential> {
    return providerId === "deepseek" && this.#secret !== undefined
      ? { type: "api_key", key: this.#secret }
      : undefined;
  }

  public async list(): Promise<readonly PiCredentialInfo[]> {
    return this.#secret === undefined ? [] : [{ providerId: "deepseek", type: "api_key" }];
  }

  public async modify(providerId: string, fn: PiCredentialModifier): Promise<PiCredential> {
    const current = await this.read(providerId);
    const next = await fn(current);
    if (providerId === "deepseek") this.#secret = next?.type === "api_key" ? next.key : undefined;
    return next;
  }

  public async delete(providerId: string): Promise<void> {
    if (providerId === "deepseek") this.#secret = undefined;
  }

  public clear(): void {
    this.#secret = undefined;
  }
}

class AsyncEventQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: ((result: IteratorResult<T>) => void)[] = [];
  #ended = false;
  #error: Error | undefined;

  public push(value: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  public fail(error: Error): void {
    this.#error = error;
    this.end();
  }

  public end(): void {
    this.#ended = true;
    while (this.#waiters.length > 0) this.#waiters.shift()!({ done: true, value: undefined });
  }

  public next(): Promise<IteratorResult<T>> {
    if (this.#values.length > 0)
      return Promise.resolve({ done: false, value: this.#values.shift()! });
    if (this.#error) return Promise.reject(this.#error);
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}
