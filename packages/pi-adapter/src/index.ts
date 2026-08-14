import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import * as piSdk from "@earendil-works/pi-coding-agent";
import { cleanChildEnvironment, type NativeProcessResult } from "@candy/platform";
import { Type } from "typebox";
import { CandyRestrictedResourceLoader } from "./restricted-resource-loader.js";

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

export type ProviderErrorReason =
  "unauthorized" | "rate_limited" | "timeout" | "http_error" | "network_error";

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
    public readonly reason: ProviderErrorReason | undefined = undefined,
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
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProviderContractError(
        "DeepSeek provider request failed.",
        "provider_error",
        classifyTransportError(error),
      );
    } finally {
      lease.release();
    }

    if (!response.ok || !response.body) {
      throw new ProviderContractError(
        response.status === 401
          ? "DeepSeek provider rejected the credential."
          : response.status === 429
            ? "DeepSeek provider rate limit reached."
            : "DeepSeek provider returned an invalid response.",
        "provider_error",
        response.status === 401
          ? "unauthorized"
          : response.status === 429
            ? "rate_limited"
            : "http_error",
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
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProviderContractError(
        "MiniMax provider request failed.",
        "provider_error",
        classifyTransportError(error),
      );
    } finally {
      lease.release();
    }
    if (!response.ok || !response.body) {
      throw new ProviderContractError(
        response.status === 401
          ? "MiniMax provider rejected the credential."
          : response.status === 429
            ? "MiniMax provider rate limit reached."
            : "MiniMax provider returned an invalid response.",
        "provider_error",
        response.status === 401
          ? "unauthorized"
          : response.status === 429
            ? "rate_limited"
            : "http_error",
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

function uniqueNonEmptySecrets(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function containsCredentialMaterial(value: string): boolean {
  return /(?:Bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,})/u.test(
    value,
  );
}

function containsActiveSecretBytes(value: Uint8Array, activeSecrets: readonly string[]): boolean {
  const bytes = Buffer.from(value);
  return activeSecrets.some(
    (secret) => secret.length > 0 && bytes.includes(Buffer.from(secret, "utf8")),
  );
}

function containsShellPublicationAction(command: string): boolean {
  // A lexical publication deny-list cannot safely reason about shell
  // variables, command substitution, or nested interpreters. Reject those
  // forms before approval so they cannot bypass the fail-closed policy.
  if (
    /[`$]/u.test(command) ||
    /(?:^|[;&|\s])(eval|source)\b/u.test(command) ||
    /(?:^|[;&|\s])(ba?sh|zsh)\s+-c\b/u.test(command)
  )
    return true;
  for (const segment of command.split(/[;&|()\n]+/u)) {
    const tokens = segment
      .trim()
      .split(/\s+/u)
      .map((token) => token.replace(/^["']|["']$/gu, "").toLowerCase())
      .filter((token) => token.length > 0);
    if (
      tokens.some((token, index) => {
        const executable = token.split(/[\\/]/u).at(-1);
        return (
          executable === "git" &&
          tokens
            .slice(index + 1)
            .some((subcommand) => subcommand === "commit" || subcommand === "push")
        );
      })
    )
      return true;
    if (tokens.some((token) => ["publish", "release", "deploy"].includes(token))) return true;
    if (
      tokens.some(
        (token, index) =>
          ["npm", "pnpm", "yarn", "cargo", "docker"].includes(token) &&
          ["publish", "push"].includes(tokens[index + 1] ?? ""),
      ) ||
      tokens.some(
        (token, index) => token === "gh" && ["release", "pr"].includes(tokens[index + 1] ?? ""),
      )
    )
      return true;
  }
  return false;
}

export interface CandyWorkspaceToolOperations {
  readonly readFile: (absolutePath: string) => Promise<Buffer>;
  readonly access: (absolutePath: string) => Promise<void>;
  readonly writeFile: (absolutePath: string, content: string) => Promise<void>;
  readonly mkdir: (directory: string) => Promise<void>;
}

export interface CandyBashPathSeam {
  readonly resolve: (...paths: string[]) => string;
  readonly isAbsolute: (value: string) => boolean;
}

export interface CandyBashOperationsOptions {
  readonly runner: {
    run(request: {
      readonly executable: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly workspace: string;
      readonly environment?: Readonly<Record<string, string>>;
      readonly activeSecrets?: readonly string[];
      readonly network?: boolean;
      readonly allowProcessExec?: boolean;
      readonly processExecPaths?: readonly string[];
      readonly readOnlyPaths?: readonly string[];
      readonly signal?: AbortSignal;
    }): Promise<NativeProcessResult>;
  };
  readonly bashPath?: string;
  readonly exists?: (absolutePath: string) => boolean;
  readonly activeSecrets?: readonly string[];
  readonly pathSeam?: CandyBashPathSeam;
  readonly onApproval?: (
    request: { readonly command: string; readonly cwd: string; readonly timeout?: number },
    signal: AbortSignal,
  ) => Promise<boolean>;
}

export interface CandyNetworkApprovalRequest {
  readonly command: string;
  readonly cwd: string;
  readonly reason: string;
  readonly timeout?: number;
}

export interface CandyNetworkOperationsOptions {
  readonly runner: CandyBashOperationsOptions["runner"];
  readonly activeSecrets?: readonly string[];
  readonly bashPath?: string;
  readonly exists?: (absolutePath: string) => boolean;
  readonly pathSeam?: CandyBashPathSeam;
  readonly onApproval: (
    request: CandyNetworkApprovalRequest,
    signal: AbortSignal,
  ) => Promise<boolean>;
}

const WINDOWS_GIT_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe";

export function createCandyBashOperations(
  workspaceRoot: string,
  options: CandyBashOperationsOptions,
): piSdk.BashOperations {
  const pathImpl = options.pathSeam ?? path;
  const root = pathImpl.resolve(workspaceRoot);
  const bashPath =
    options.bashPath ?? (process.platform === "win32" ? WINDOWS_GIT_BASH_PATH : "/bin/bash");
  return {
    exec: async (command, cwd, execution) => {
      if (pathImpl.resolve(cwd) !== root)
        throw new Error("Trusted Shell cwd must be the Task Worktree.");
      if (!pathImpl.isAbsolute(bashPath)) throw new Error("Trusted Shell executable is invalid.");
      if (!(options.exists ?? existsSync)(bashPath))
        throw new Error(`Git Bash was not found at ${bashPath}.`);
      if (
        execution.timeout !== undefined &&
        (!Number.isFinite(execution.timeout) || execution.timeout <= 0)
      )
        throw new Error("Invalid timeout.");
      if (
        containsCredentialMaterial(command) ||
        (options.activeSecrets ?? []).some(
          (secret) => secret.length > 0 && command.includes(secret),
        )
      )
        throw new Error("Provider credentials are forbidden in Trusted Shell commands.");
      if (containsShellPublicationAction(command))
        throw new Error("Repository publication and external release actions are forbidden.");
      const approved =
        options.onApproval === undefined
          ? true
          : await options.onApproval(
              {
                command,
                cwd: root,
                ...(execution.timeout === undefined ? {} : { timeout: execution.timeout }),
              },
              execution.signal ?? new AbortController().signal,
            );
      if (!approved) throw new Error("Shell command denied by the user.");
      if (execution.signal?.aborted) throw new Error("aborted");
      const controller = new AbortController();
      const abort = (): void => controller.abort(execution.signal?.reason);
      const timeoutHandle =
        execution.timeout === undefined
          ? undefined
          : setTimeout(() => controller.abort(new Error("timeout")), execution.timeout * 1000);
      if (execution.signal?.aborted) abort();
      else execution.signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await options.runner.run({
          executable: bashPath,
          args: ["--noprofile", "--norc", "-c", wrapCandyShellCommand(command)],
          cwd: root,
          workspace: root,
          network: false,
          allowProcessExec: true,
          processExecPaths: [path.dirname(process.execPath)],
          readOnlyPaths: await resolveCandyShellReadOnlyPaths(root),
          environment: createCandyShellEnvironment(root, options.activeSecrets ?? []),
          ...(options.activeSecrets === undefined ? {} : { activeSecrets: options.activeSecrets }),
          signal: controller.signal,
        });
        const output = redactBashOutput(
          `${result.stdout}${result.stderr}`,
          options.activeSecrets ?? [],
        );
        if (output.length > 0) execution.onData(Buffer.from(output));
        if (result.cancelled) {
          if (
            controller.signal.reason instanceof Error &&
            controller.signal.reason.message === "timeout"
          )
            throw new Error(`timeout:${execution.timeout}`);
          throw new Error("aborted");
        }
        return { exitCode: result.code };
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        execution.signal?.removeEventListener("abort", abort);
      }
    },
  };
}

const networkShellSchema = Type.Object(
  {
    command: Type.String({
      description: "Complete Bash command that needs one-command network access",
      minLength: 1,
      maxLength: 100_000,
    }),
    reason: Type.String({
      description: "Why this command needs network access",
      minLength: 1,
      maxLength: 2_048,
    }),
    timeout: Type.Optional(
      Type.Number({
        description: "Timeout in seconds (optional)",
        exclusiveMinimum: 0,
        maximum: 3_600,
      }),
    ),
  },
  { additionalProperties: false },
);

const MAX_NETWORK_TIMEOUT_SECONDS = 3_600;
const MAX_NETWORK_COMMAND_LENGTH = 100_000;
const MAX_NETWORK_REASON_LENGTH = 2_048;

interface CandyNetworkToolInput {
  readonly command: string;
  readonly reason: string;
  readonly timeout?: number;
}

/**
 * Candy-owned network elevation tool. The normal Pi Bash definition remains
 * the offline path; this tool makes network an explicit, single-use capability.
 */
export function createCandyNetworkToolDefinition(
  workspaceRoot: string,
  options: CandyNetworkOperationsOptions,
): piSdk.ToolDefinition {
  const pathImpl = options.pathSeam ?? path;
  const root = pathImpl.resolve(workspaceRoot);
  const bashPath =
    options.bashPath ?? (process.platform === "win32" ? WINDOWS_GIT_BASH_PATH : "/bin/bash");
  return {
    name: "candy_bash_network",
    label: "Trusted Shell network elevation",
    description:
      "Request one-time outbound network access for a complete command in the current Task Worktree. The user must approve each request.",
    promptSnippet: "Request one-command network access for a shell command",
    promptGuidelines: [
      "Use candy_bash_network only when the command genuinely needs outbound network access.",
      "Provide a concise reason. Network access is denied by default and is never retained for later commands.",
    ],
    parameters: networkShellSchema,
    executionMode: "sequential",
    execute: async (
      _toolCallId: string,
      input: CandyNetworkToolInput,
      signal: AbortSignal | undefined,
    ) => {
      const executionSignal = signal ?? new AbortController().signal;
      if (executionSignal.aborted) throw new Error("Operation aborted");
      if (pathImpl.resolve(root) !== root || !pathImpl.isAbsolute(bashPath))
        throw new Error("Trusted Shell executable is invalid.");
      if (!(options.exists ?? existsSync)(bashPath))
        throw new Error(`Git Bash was not found at ${bashPath}.`);
      if (
        typeof input.command !== "string" ||
        input.command.length === 0 ||
        input.command.length > MAX_NETWORK_COMMAND_LENGTH ||
        typeof input.reason !== "string" ||
        input.reason.length === 0 ||
        input.reason.length > MAX_NETWORK_REASON_LENGTH
      )
        throw new Error("Network shell command or reason is outside the allowed bounds.");
      if (
        input.timeout !== undefined &&
        (!Number.isFinite(input.timeout) ||
          input.timeout <= 0 ||
          input.timeout > MAX_NETWORK_TIMEOUT_SECONDS)
      )
        throw new Error("Invalid timeout.");
      if (
        containsCredentialMaterial(input.command) ||
        containsCredentialMaterial(input.reason) ||
        (options.activeSecrets ?? []).some(
          (secret) =>
            secret.length > 0 && (input.command.includes(secret) || input.reason.includes(secret)),
        )
      )
        throw new Error("Provider credentials are forbidden in Trusted Shell commands.");
      if (containsShellPublicationAction(input.command))
        throw new Error("Repository publication and external release actions are forbidden.");
      const approved = await options.onApproval(
        {
          command: input.command,
          cwd: root,
          reason: input.reason,
          ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
        },
        executionSignal,
      );
      if (!approved) throw new Error("Shell network request denied by the user.");
      if (executionSignal.aborted) throw new Error("Operation aborted");
      const controller = new AbortController();
      const abort = (): void => controller.abort(executionSignal.reason);
      const timeoutHandle =
        input.timeout === undefined
          ? undefined
          : setTimeout(() => controller.abort(new Error("timeout")), input.timeout * 1000);
      if (executionSignal.aborted) abort();
      else executionSignal.addEventListener("abort", abort, { once: true });
      try {
        const result = await options.runner.run({
          executable: bashPath,
          args: ["--noprofile", "--norc", "-c", wrapCandyShellCommand(input.command)],
          cwd: root,
          workspace: root,
          network: true,
          allowProcessExec: true,
          processExecPaths: [path.dirname(process.execPath)],
          readOnlyPaths: await resolveCandyShellReadOnlyPaths(root),
          environment: createCandyShellEnvironment(root, options.activeSecrets ?? []),
          ...(options.activeSecrets === undefined ? {} : { activeSecrets: options.activeSecrets }),
          signal: controller.signal,
        });
        const output = redactBashOutput(
          `${result.stdout}${result.stderr}`,
          options.activeSecrets ?? [],
        );
        if (result.cancelled) {
          if (
            controller.signal.reason instanceof Error &&
            controller.signal.reason.message === "timeout"
          )
            throw new Error(`timeout:${input.timeout}`);
          throw new Error("aborted");
        }
        return {
          content: [{ type: "text" as const, text: output || "(no output)" }],
          details: { exitCode: result.code },
        };
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        executionSignal.removeEventListener("abort", abort);
      }
    },
  } as unknown as piSdk.ToolDefinition;
}

function redactBashOutput(value: string, activeSecrets: readonly string[]): string {
  return activeSecrets
    .reduce(
      (result, secret) => (secret.length === 0 ? result : result.split(secret).join("[REDACTED]")),
      value,
    )
    .replace(
      /(?:Bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,})/gu,
      "[REDACTED]",
    );
}

function wrapCandyShellCommand(command: string): string {
  return [
    'trap \'status=$?; trap - EXIT; for pid in $(jobs -pr); do kill "$pid" 2>/dev/null || true; done; exit "$status"\' EXIT',
    command,
  ].join("\n");
}

function createCandyShellEnvironment(
  workspaceRoot: string,
  activeSecrets: readonly string[],
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(cleanChildEnvironment(process.env, activeSecrets)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (process.platform === "darwin") {
    environment.HOME = workspaceRoot;
    environment.PATH = [
      path.dirname(process.execPath),
      "/Library/Developer/CommandLineTools/usr/bin",
      environment.PATH,
      "/usr/bin",
      "/bin",
    ]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(":");
    environment.GIT_CONFIG_NOSYSTEM = "1";
  }
  return environment;
}

async function resolveCandyShellReadOnlyPaths(root: string): Promise<readonly string[]> {
  const marker = path.join(root, ".git");
  const markerMetadata = await lstat(marker).catch(() => undefined);
  if (markerMetadata === undefined) return [];
  if (markerMetadata.isSymbolicLink())
    throw new Error("Trusted Shell Git metadata marker cannot be a symbolic link.");
  const paths = [marker];
  let gitDirectory: string | undefined;
  if (markerMetadata.isDirectory()) {
    gitDirectory = await realpath(marker).catch(() => undefined);
  } else if (markerMetadata.isFile()) {
    const contents = await readFile(marker, "utf8").catch(() => "");
    const target = contents.match(/^gitdir:\s*(.+?)\s*$/mu)?.[1];
    if (target !== undefined) {
      gitDirectory = await realpath(
        path.isAbsolute(target) ? target : path.resolve(path.dirname(marker), target),
      ).catch(() => undefined);
    }
  }
  if (gitDirectory === undefined) return paths;
  paths.push(gitDirectory);
  const commondir = await readFile(path.join(gitDirectory, "commondir"), "utf8").catch(() => "");
  const commonTarget = commondir.trim();
  if (commonTarget.length > 0) {
    const commonDirectory = await realpath(
      path.isAbsolute(commonTarget) ? commonTarget : path.resolve(gitDirectory, commonTarget),
    ).catch(() => undefined);
    if (commonDirectory !== undefined) paths.push(commonDirectory);
  }
  return [...new Set(paths)];
}

/**
 * File operations shared by Pi's public read/edit/write definitions. Pi still
 * owns tool schemas and rendering; Candy owns the workspace boundary.
 */
export function createCandyWorkspaceOperations(
  workspaceRoot: string,
  activeSecrets: readonly string[] = [],
): CandyWorkspaceToolOperations {
  const root = path.resolve(workspaceRoot);
  return {
    readFile: async (absolutePath) => {
      await assertWorkspacePath(root, absolutePath, false);
      return readFile(absolutePath);
    },
    access: async (absolutePath) => {
      await assertWorkspacePath(root, absolutePath, false);
      await access(absolutePath);
    },
    writeFile: async (absolutePath, content) => {
      await assertWorkspacePath(root, absolutePath, true);
      if (
        containsCredentialMaterial(content) ||
        activeSecrets.some((secret) => secret.length > 0 && content.includes(secret))
      )
        throw new Error("Provider credentials are forbidden in workspace writes.");
      await writeFile(absolutePath, content, "utf8");
    },
    mkdir: async (directory) => {
      await assertWorkspacePath(root, directory, true);
      await mkdir(directory, { recursive: true });
      await assertWorkspacePath(root, directory, false);
    },
  };
}

async function readWorkspaceFileForModel(
  operations: CandyWorkspaceToolOperations,
  absolutePath: string,
  activeSecrets: readonly string[],
): Promise<Buffer> {
  const content = await operations.readFile(absolutePath);
  if (content.includes(0)) {
    if (containsActiveSecretBytes(content, activeSecrets))
      throw new Error("Provider credentials are forbidden in binary workspace reads.");
    return content;
  }
  return Buffer.from(redactBashOutput(content.toString("utf8"), activeSecrets), "utf8");
}

export interface FileDeleteApprovalRequest {
  readonly path: string;
}

export type FileDeleteApproval = (
  request: FileDeleteApprovalRequest,
  signal: AbortSignal,
) => Promise<boolean>;

const deleteFileSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to delete (relative or absolute)" }),
  },
  { additionalProperties: false },
);

const listWorkspaceSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        description: "Workspace-relative directory path; defaults to the workspace root",
        maxLength: 4_096,
      }),
    ),
  },
  { additionalProperties: false },
);

const searchWorkspaceSchema = Type.Object(
  {
    query: Type.String({
      description: "Literal text to search for in UTF-8 text files",
      minLength: 1,
      maxLength: 256,
    }),
    path: Type.Optional(
      Type.String({
        description: "Workspace-relative file or directory path; defaults to the workspace root",
        maxLength: 4_096,
      }),
    ),
  },
  { additionalProperties: false },
);

const MAX_BROWSE_RESULT_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_DIRECTORIES = 2_000;
const MAX_SEARCH_FILES = 1_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 1 * 1024 * 1024;
const MAX_SEARCH_LINE_CHARS = 2_048;
const IGNORED_BROWSE_DIRECTORIES = new Set([
  ".cache",
  ".candy",
  ".candy-data",
  ".git",
  ".gradle",
  ".hg",
  ".next",
  ".pnpm-store",
  ".pytest_cache",
  ".svn",
  ".turbo",
  ".venv",
  "attachments",
  "app-data",
  "appdata",
  "browser-profile",
  "build",
  "candy-app-data",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "pods",
  "sessions",
  "target",
  "candy data",
  "venv",
  "worktrees",
]);

interface CandyBrowseEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

interface CandyBrowseMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

interface CandyWorkspaceBrowseTools {
  readonly list: (
    requestedPath: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ readonly entries: readonly CandyBrowseEntry[]; readonly truncated: boolean }>;
  readonly search: (
    query: string,
    requestedPath: string | undefined,
    signal: AbortSignal,
  ) => Promise<{
    readonly matches: readonly CandyBrowseMatch[];
    readonly filesScanned: number;
    readonly truncated: boolean;
  }>;
}

function createCandyWorkspaceBrowseTools(
  workspaceRoot: string,
  activeSecrets: readonly string[] = [],
): CandyWorkspaceBrowseTools {
  const root = path.resolve(workspaceRoot);
  return {
    list: async (requestedPath, signal) => {
      const absolutePath = await resolveBrowsePath(root, requestedPath);
      throwIfToolAborted(signal);
      const directory = await lstat(absolutePath);
      if (!directory.isDirectory()) throw new Error("candy_list requires a workspace directory.");
      const entries: CandyBrowseEntry[] = [];
      let truncated = false;
      const children = (await readdir(absolutePath, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      for (const child of children) {
        throwIfToolAborted(signal);
        if (!isSafeFilesystemText(child.name)) continue;
        if (isIgnoredBrowseDirectory(child.name) && child.isDirectory()) continue;
        if (child.isSymbolicLink()) continue;
        const childPath = path.join(absolutePath, child.name);
        const childStats = await lstat(childPath);
        if (childStats.isSymbolicLink()) continue;
        if (!childStats.isDirectory() && !childStats.isFile()) continue;
        await assertBrowsePath(root, childPath);
        const entry: CandyBrowseEntry = {
          path: relativeBrowsePath(root, childPath),
          kind: childStats.isDirectory() ? "directory" : "file",
        };
        if (
          entries.length >= MAX_LIST_ENTRIES ||
          !fitsBrowseResult({ entries: [...entries, entry], truncated: false })
        ) {
          truncated = true;
          break;
        }
        entries.push(entry);
      }
      return { entries, truncated };
    },
    search: async (query, requestedPath, signal) => {
      assertBrowseInput(query, "Search queries");
      if (
        containsCredentialMaterial(query) ||
        activeSecrets.some((secret) => secret.length > 0 && query.includes(secret))
      ) {
        throw new Error("Provider credentials are forbidden in workspace search queries.");
      }
      const absolutePath = await resolveBrowsePath(root, requestedPath);
      const startStats = await lstat(absolutePath);
      const pending = [
        {
          absolutePath,
          relativePath: relativeBrowsePath(root, absolutePath),
          stats: startStats,
        },
      ];
      const matches: CandyBrowseMatch[] = [];
      let filesScanned = 0;
      let directoriesScanned = 0;
      let truncated = false;
      while (pending.length > 0) {
        throwIfToolAborted(signal);
        const current = pending.shift();
        if (!current) break;
        if (current.stats.isSymbolicLink()) continue;
        await assertBrowsePath(root, current.absolutePath);
        if (current.stats.isDirectory()) {
          directoriesScanned += 1;
          if (directoriesScanned > MAX_SEARCH_DIRECTORIES) {
            truncated = true;
            break;
          }
          const children = (await readdir(current.absolutePath, { withFileTypes: true })).sort(
            (left, right) => left.name.localeCompare(right.name),
          );
          for (const child of children) {
            throwIfToolAborted(signal);
            if (!isSafeFilesystemText(child.name)) continue;
            if (child.isSymbolicLink()) continue;
            if (child.isDirectory() && isIgnoredBrowseDirectory(child.name)) continue;
            const childPath = path.join(current.absolutePath, child.name);
            const childStats = await lstat(childPath);
            if (!childStats.isDirectory() && !childStats.isFile()) continue;
            pending.push({
              absolutePath: childPath,
              relativePath: relativeBrowsePath(root, childPath),
              stats: childStats,
            });
          }
          continue;
        }
        if (!current.stats.isFile() || current.stats.size > MAX_SEARCH_FILE_BYTES) continue;
        filesScanned += 1;
        if (filesScanned > MAX_SEARCH_FILES) {
          truncated = true;
          break;
        }
        const buffer = await readFile(current.absolutePath);
        throwIfToolAborted(signal);
        if (buffer.includes(0)) continue;
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        } catch {
          continue;
        }
        content = redactBashOutput(content, activeSecrets);
        const lines = content.split(/\r?\n/u);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          throwIfToolAborted(signal);
          const line = lines[lineIndex] ?? "";
          const columnIndex = line.indexOf(query);
          if (columnIndex < 0) continue;
          const text = line.slice(0, MAX_SEARCH_LINE_CHARS);
          const match: CandyBrowseMatch = {
            path: current.relativePath,
            line: lineIndex + 1,
            column: columnIndex + 1,
            text,
          };
          if (
            matches.length >= MAX_SEARCH_MATCHES ||
            !fitsBrowseResult({
              matches: [...matches, match],
              filesScanned,
              truncated: false,
            })
          ) {
            truncated = true;
            break;
          }
          matches.push(match);
          if (line.length > MAX_SEARCH_LINE_CHARS) truncated = true;
        }
        if (truncated && matches.length >= MAX_SEARCH_MATCHES) break;
      }
      return { matches, filesScanned, truncated };
    },
  };
}

function isIgnoredBrowseDirectory(name: string): boolean {
  return IGNORED_BROWSE_DIRECTORIES.has(name) || IGNORED_BROWSE_DIRECTORIES.has(name.toLowerCase());
}

function isSafeFilesystemText(value: string): boolean {
  return (
    !containsControlCharacter(value) &&
    !containsUnpairedSurrogate(value) &&
    !value.includes("\ufffd")
  );
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function assertBrowseInput(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} cannot be empty.`);
  if (value.length > 4_096 || !isSafeFilesystemText(value)) {
    throw new Error(`${label} contain invalid or control characters.`);
  }
}

async function resolveBrowsePath(root: string, requestedPath: string | undefined): Promise<string> {
  const value = requestedPath ?? ".";
  assertBrowseInput(value, "Workspace browse paths");
  if (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.win32.parse(value).root !== ""
  ) {
    throw new Error("Workspace browse paths must be relative.");
  }
  if (value.split(/[\\/]+/u).some((segment) => segment === "..")) {
    throw new Error("Workspace browse path escaped the selected workspace.");
  }
  const absolutePath = path.resolve(root, value);
  await assertBrowsePath(root, absolutePath);
  return absolutePath;
}

async function assertBrowsePath(root: string, candidate: string): Promise<void> {
  await assertWorkspacePath(root, candidate, false);
  const realRoot = await realpath(root);
  const realCandidate = await realpath(candidate);
  const relative = path.relative(realRoot, realCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workspace browse path escaped the selected workspace.");
  }
}

function relativeBrowsePath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return normalizeWorkspaceToolPath(relative || ".");
}

function fitsBrowseResult(value: object): boolean {
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_BROWSE_RESULT_BYTES;
}

function browseResult(value: object): {
  readonly content: [{ readonly type: "text"; readonly text: string }];
  readonly details: undefined;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: undefined,
  };
}

export function createCandyWorkspaceTools(
  workspaceRoot: string,
  approvalProfile: "read-only" | "auto",
  shell?: {
    readonly runner: CandyBashOperationsOptions["runner"];
    readonly activeSecrets?: readonly string[];
    readonly onApproval?: CandyBashOperationsOptions["onApproval"];
    readonly networkApproval?: CandyNetworkOperationsOptions["onApproval"];
  },
  fileDeleteApproval?: FileDeleteApproval,
  activeSecrets: readonly string[] = [],
) {
  const operations = createCandyWorkspaceOperations(workspaceRoot, activeSecrets);
  const browseTools = createCandyWorkspaceBrowseTools(workspaceRoot, activeSecrets);
  const read = piSdk.createReadToolDefinition(workspaceRoot, {
    operations: {
      readFile: (absolutePath) =>
        readWorkspaceFileForModel(operations, absolutePath, activeSecrets),
      access: operations.access,
    },
  });
  const tools: piSdk.ToolDefinition[] = [
    {
      name: "candy_list",
      label: "List workspace files",
      description:
        "List immediate files and directories inside the selected workspace without following symbolic links.",
      promptSnippet: "List files and directories in the selected workspace",
      parameters: listWorkspaceSchema,
      executionMode: "parallel",
      execute: async (_toolCallId, { path: requestedPath }, signal) =>
        browseResult(await browseTools.list(requestedPath, signal ?? new AbortController().signal)),
    },
    {
      name: "candy_search",
      label: "Search workspace text",
      description:
        "Search literal text in bounded UTF-8 workspace files without using Shell, ripgrep, or Pi built-in tools.",
      promptSnippet: "Search text files inside the selected workspace",
      parameters: searchWorkspaceSchema,
      executionMode: "parallel",
      execute: async (_toolCallId, { query, path: requestedPath }, signal) =>
        browseResult(
          await browseTools.search(query, requestedPath, signal ?? new AbortController().signal),
        ),
    },
    {
      ...read,
      name: "candy_read",
      label: "Read workspace file",
      promptSnippet: "Read files inside the selected workspace",
    } as unknown as piSdk.ToolDefinition,
  ];
  if (approvalProfile === "auto") {
    const edit = piSdk.createEditToolDefinition(workspaceRoot, {
      operations: {
        readFile: operations.readFile,
        writeFile: operations.writeFile,
        access: operations.access,
      },
    });
    const write = piSdk.createWriteToolDefinition(workspaceRoot, {
      operations: { writeFile: operations.writeFile, mkdir: operations.mkdir },
    });
    tools.push(
      {
        ...edit,
        name: "candy_edit",
        label: "Edit workspace file",
        promptSnippet: "Make precise edits inside the selected workspace",
      } as unknown as piSdk.ToolDefinition,
      {
        ...write,
        name: "candy_write",
        label: "Write workspace file",
        promptSnippet: "Create or overwrite files inside the selected workspace",
      } as unknown as piSdk.ToolDefinition,
    );
    if (fileDeleteApproval !== undefined) {
      tools.push({
        name: "candy_delete",
        label: "Delete workspace file",
        description:
          "Delete one regular file inside the selected workspace after explicit user approval. Directories and symbolic links are not supported.",
        promptSnippet: "Delete an approved regular file inside the selected workspace",
        promptGuidelines: [
          "Use candy_delete only when the user asked to remove a file; every deletion requires explicit confirmation.",
        ],
        parameters: deleteFileSchema,
        executionMode: "sequential",
        execute: async (_toolCallId, { path: requestedPath }, signal) => {
          if (containsControlCharacter(requestedPath)) {
            throw new Error("File deletion paths cannot contain control characters.");
          }
          const operationSignal = signal ?? new AbortController().signal;
          const absolutePath = path.resolve(workspaceRoot, requestedPath);
          const relativePath = normalizeWorkspaceToolPath(
            path.relative(path.resolve(workspaceRoot), absolutePath),
          );
          return piSdk.withFileMutationQueue(absolutePath, async () => {
            throwIfToolAborted(operationSignal);
            await assertWorkspacePath(path.resolve(workspaceRoot), absolutePath, false);
            const before = await lstat(absolutePath);
            if (!before.isFile()) throw new Error("Only regular workspace files can be deleted.");
            throwIfToolAborted(operationSignal);
            const approved = await fileDeleteApproval({ path: relativePath }, operationSignal);
            if (!approved) throw new Error("File deletion was denied by the user.");
            throwIfToolAborted(operationSignal);
            await assertWorkspacePath(path.resolve(workspaceRoot), absolutePath, false);
            const after = await lstat(absolutePath);
            if (!after.isFile() || !sameFileSnapshot(before, after)) {
              throw new Error("The file changed while deletion approval was pending.");
            }
            await unlink(absolutePath);
            throwIfToolAborted(operationSignal);
            return {
              content: [{ type: "text" as const, text: `Deleted ${relativePath}` }],
              details: undefined,
            };
          });
        },
      });
    }
    if (shell !== undefined) {
      const bash = piSdk.createBashToolDefinition(workspaceRoot, {
        operations: createCandyBashOperations(workspaceRoot, {
          runner: shell.runner,
          ...(shell.activeSecrets === undefined ? {} : { activeSecrets: shell.activeSecrets }),
          ...(shell.onApproval === undefined ? {} : { onApproval: shell.onApproval }),
        }),
        exposeSessionEnvironment: false,
      });
      tools.push({
        ...bash,
        name: "candy_bash",
        label: "Trusted Shell",
        promptSnippet: "Run an approved command in the selected Task Worktree",
      } as unknown as piSdk.ToolDefinition);
      if (shell.networkApproval !== undefined) {
        tools.push(
          createCandyNetworkToolDefinition(workspaceRoot, {
            runner: shell.runner,
            ...(shell.activeSecrets === undefined ? {} : { activeSecrets: shell.activeSecrets }),
            onApproval: shell.networkApproval,
          }),
        );
      }
    }
  }
  return tools;
}

function throwIfToolAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Operation aborted");
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function normalizeWorkspaceToolPath(value: string): string {
  return value.replaceAll(path.sep, "/");
}

function sameFileSnapshot(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  );
}

async function assertWorkspacePath(
  root: string,
  candidate: string,
  allowMissing: boolean,
): Promise<void> {
  if (!path.isAbsolute(candidate)) throw new Error("Workspace tool paths must be absolute.");
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workspace tool path escaped the selected workspace.");
  }
  if ((await lstat(absoluteRoot)).isSymbolicLink())
    throw new Error("The selected workspace cannot be a symbolic link.");
  let current = absoluteRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Symbolic links are not allowed in workspace tool paths.");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT" && allowMissing) return;
      throw error;
    }
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
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
  readonly model: "deepseek-v4-flash" | "deepseek-v4-pro" | "MiniMax-M3";
  readonly cwd: string;
  readonly approvalProfile?: "read-only" | "auto";
  readonly images?: readonly PiImageInput[];
  /** All Candy-owned provider secrets active for this turn's model-visible sinks. */
  readonly activeSecrets?: readonly string[];
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly trustedShell?: boolean;
  /** All Candy-owned provider secrets currently active for Shell redaction. */
  readonly shellActiveSecrets?: readonly string[];
  readonly shellApproval?: CandyBashOperationsOptions["onApproval"];
  readonly shellNetworkApproval?: CandyNetworkOperationsOptions["onApproval"];
  readonly fileDeleteApproval?: FileDeleteApproval;
}

export interface PiImageInput {
  readonly mimeType: string;
  readonly data: string;
}

export type PiAgentObservation =
  | { readonly type: "turn.started"; readonly taskId: string }
  | { readonly type: "assistant.thinking.delta"; readonly taskId: string; readonly text: string }
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
    private readonly provider: CandyProvider = "deepseek",
    private readonly bashRunner?: CandyBashOperationsOptions["runner"],
  ) {}

  public async recoverPrompt(taskId: string, cwd: string): Promise<string | undefined> {
    const sessionDirectory = path.join(this.sessionRoot, taskId);
    const existing = (await piSdk.SessionManager.listAll(sessionDirectory)).sort(
      (left, right) => right.modified.getTime() - left.modified.getTime(),
    )[0];
    if (!existing) return undefined;
    const content = await readFile(existing.path, "utf8");
    void piSdk.SessionManager.open(existing.path, sessionDirectory, cwd);
    const entries = content
      .split(/\r?\n/u)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return undefined;
        }
      })
      .filter(isRecord);
    for (const entry of entries.reverse()) {
      if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user")
        continue;
      const messageContent = entry.message.content;
      const prompt =
        typeof messageContent === "string"
          ? messageContent
          : Array.isArray(messageContent)
            ? messageContent
                .filter(isRecord)
                .filter((part) => part.type === "text" && typeof part.text === "string")
                .map((part) => String(part.text))
                .join("")
            : "";
      if (prompt.length > 0) return prompt;
    }
    return undefined;
  }

  public async *runTurn(
    input: PiAgentEngineInput,
    signal: AbortSignal,
  ): AsyncIterable<PiAgentObservation> {
    const lease = await this.acquireSecret();
    if (!lease)
      throw new ProviderContractError("DeepSeek credentials are unavailable.", "needs_credentials");
    const activeSecrets = uniqueNonEmptySecrets([
      lease.secret,
      ...(input.activeSecrets ?? []),
      ...(input.shellActiveSecrets ?? []),
    ]);
    if (
      containsCredentialMaterial(input.prompt) ||
      activeSecrets.some((secret) => input.prompt.includes(secret))
    ) {
      lease.release();
      throw new ProviderContractError(
        "Credential-shaped prompt content is forbidden.",
        "provider_error",
      );
    }
    if (this.provider === "deepseek" && input.images?.length) {
      lease.release();
      throw new ProviderContractError(
        "DeepSeek does not accept image attachments; switch to MiniMax M3.",
        "provider_error",
      );
    }
    if (this.provider === "minimax-cn" && input.model !== "MiniMax-M3") {
      lease.release();
      throw new ProviderContractError("MiniMax requires the exact M3 model.", "provider_error");
    }
    if (this.provider === "deepseek" && input.model === "MiniMax-M3") {
      lease.release();
      throw new ProviderContractError(
        "MiniMax M3 requires the MiniMax provider.",
        "provider_error",
      );
    }
    const sessionDirectory = path.join(this.sessionRoot, input.taskId);
    await mkdir(sessionDirectory, { recursive: true });
    const credentialStore = new PiCredentialStore(lease.secret, this.provider);
    let session: piSdk.AgentSession | undefined;
    try {
      const modelRuntime = await piSdk.ModelRuntime.create({
        credentials: credentialStore,
        modelsPath: null,
        refreshOnCreate: false,
      });
      const model = modelRuntime.getModel(this.provider, input.model);
      if (!model)
        throw new ProviderContractError("Requested model is not available.", "provider_error");
      if (
        this.provider === "minimax-cn" &&
        model.baseUrl !== "https://api.minimaxi.com/anthropic"
      ) {
        throw new ProviderContractError(
          "MiniMax domestic endpoint is not available.",
          "provider_error",
        );
      }
      const existing = (await piSdk.SessionManager.listAll(sessionDirectory)).sort(
        (left, right) => right.modified.getTime() - left.modified.getTime(),
      )[0];
      const sessionManager = existing
        ? piSdk.SessionManager.open(existing.path, sessionDirectory, input.cwd)
        : piSdk.SessionManager.create(input.cwd, sessionDirectory);
      const settingsManager = piSdk.SettingsManager.inMemory({}, { projectTrusted: false });
      const resourceLoader = new CandyRestrictedResourceLoader(input.cwd, undefined, activeSecrets);
      const workspaceTools = createCandyWorkspaceTools(
        input.cwd,
        input.approvalProfile ?? "read-only",
        input.trustedShell && this.bashRunner !== undefined
          ? {
              runner: this.bashRunner,
              activeSecrets,
              ...(input.shellApproval === undefined ? {} : { onApproval: input.shellApproval }),
              ...(input.shellNetworkApproval === undefined
                ? {}
                : { networkApproval: input.shellNetworkApproval }),
            }
          : undefined,
        input.fileDeleteApproval,
        activeSecrets,
      );
      const created = await piSdk.createAgentSession({
        cwd: input.cwd,
        agentDir: path.join(this.sessionRoot, "pi-agent"),
        modelRuntime,
        model,
        sessionManager,
        noTools: "builtin",
        tools: workspaceTools.map((tool) => tool.name),
        customTools: workspaceTools,
        resourceLoader,
        settingsManager,
      });
      session = created.session;
      if (input.thinkingLevel !== undefined) {
        session.setThinkingLevel(input.thinkingLevel);
      }
      const events = new AsyncEventQueue<piSdk.AgentSessionEvent>();
      const unsubscribe = session.subscribe((event) => events.push(event));
      const abort = (): void => session?.agent.abort();
      signal.addEventListener("abort", abort, { once: true });
      let promptError: Error | undefined;
      const promptPromise = session
        .prompt(
          input.prompt,
          input.images?.length
            ? {
                images: input.images.map((image) => ({
                  type: "image" as const,
                  data: image.data,
                  mimeType: image.mimeType,
                })),
              }
            : undefined,
        )
        .catch((error: unknown) => {
          promptError = signal.aborted
            ? new Error("Pi agent turn cancelled.")
            : sanitizePiProviderError(error);
          events.fail(promptError);
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
            event.value.assistantMessageEvent.type === "thinking_delta"
          ) {
            yield {
              type: "assistant.thinking.delta",
              taskId: input.taskId,
              text: redactBashOutput(event.value.assistantMessageEvent.delta, activeSecrets),
            };
          } else if (
            event.value.type === "message_update" &&
            event.value.assistantMessageEvent.type === "text_delta"
          ) {
            yield {
              type: "assistant.delta",
              taskId: input.taskId,
              text: redactBashOutput(event.value.assistantMessageEvent.delta, activeSecrets),
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
          } else if (
            event.value.type === "message_end" &&
            event.value.message.role === "assistant" &&
            event.value.message.stopReason === "error"
          ) {
            promptError ??= sanitizePiProviderError(
              new Error(event.value.message.errorMessage ?? "Provider request failed."),
            );
          } else if (event.value.type === "agent_end") {
            await promptPromise;
            if (promptError !== undefined) throw promptError;
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

/** Pi-backed MiniMax M3 path. It is explicit so image turns cannot silently use DeepSeek. */
export class MiniMaxPiAgentEngine extends PiAgentEngine {
  public constructor(
    sessionRoot: string,
    acquireSecret: SecretLeaseProvider,
    bashRunner?: CandyBashOperationsOptions["runner"],
  ) {
    super(sessionRoot, acquireSecret, "minimax-cn", bashRunner);
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

  public constructor(
    secret: string,
    private readonly provider: CandyProvider,
  ) {
    this.#secret = secret;
  }

  public async read(providerId: string): Promise<PiCredential> {
    return providerId === this.provider && this.#secret !== undefined
      ? { type: "api_key", key: this.#secret }
      : undefined;
  }

  public async list(): Promise<readonly PiCredentialInfo[]> {
    return this.#secret === undefined ? [] : [{ providerId: this.provider, type: "api_key" }];
  }

  public async modify(providerId: string, fn: PiCredentialModifier): Promise<PiCredential> {
    const current = await this.read(providerId);
    const next = await fn(current);
    if (providerId === this.provider)
      this.#secret = next?.type === "api_key" ? next.key : undefined;
    return next;
  }

  public async delete(providerId: string): Promise<void> {
    if (providerId === this.provider) this.#secret = undefined;
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

function classifyTransportError(error: unknown): ProviderErrorReason {
  if (!(error instanceof Error)) return "network_error";
  if (
    error.name === "TimeoutError" ||
    /timed? ?out|timeout|headers_timeout/iu.test(error.message)
  ) {
    return "timeout";
  }
  return "network_error";
}

function sanitizePiProviderError(error: unknown): ProviderContractError {
  if (error instanceof ProviderContractError) return error;
  const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined;
  const message = error instanceof Error ? error.message : "";
  const reason: ProviderErrorReason =
    status === 401 || /\b401\b|unauthorized|invalid api key/iu.test(message)
      ? "unauthorized"
      : status === 429 || /\b429\b|rate.?limit|too many requests/iu.test(message)
        ? "rate_limited"
        : classifyTransportError(error);
  return new ProviderContractError(
    reason === "unauthorized"
      ? "Provider rejected the credential."
      : reason === "rate_limited"
        ? "Provider rate limit reached."
        : reason === "timeout"
          ? "Provider request timed out."
          : "Provider request failed.",
    "provider_error",
    reason,
  );
}
