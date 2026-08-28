import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { cleanChildEnvironment } from "./index.js";
import { containsCredentialMaterial } from "./credential-guard.js";

const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_PROTOCOL_LINE_BYTES = 1_048_576;
const MAX_NATIVE_REQUEST_BYTES = MAX_PROTOCOL_LINE_BYTES - 1;
// Rust bounds each child stream to MAX_OUTPUT_BYTES before serde_json encoding.
// A control character can expand to six JSON bytes, so both streams need a
// larger protocol-frame bound than the raw child-output bound.
const MAX_RESPONSE_BYTES = MAX_OUTPUT_BYTES * 12 + 4_096;

export interface NativeProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly workspace: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly activeSecrets?: readonly string[];
  /** Explicit one-command capability. Omitted/false is the offline default. */
  readonly network?: boolean;
  /**
   * macOS Personal Preview only. Runs the task command outside the normal
   * filesystem and network sandbox while retaining Candy's cleared child
   * environment and owned process-tree lifecycle.
   */
  readonly fullAccess?: boolean;
  /**
   * Wide shell policy for executing child tools; validators keep this off.
   * When off, only the literal executable plus the explicit processExecPaths
   * below may run.
   */
  readonly allowProcessExec?: boolean;
  /**
   * Explicit executable/library directories an approved composition may spawn
   * and map (offline shell tools, or bounded git remote helpers for a
   * network command). Applied as subpath allow rules; validators keep empty.
   */
  readonly processExecPaths?: readonly string[];
  /** Paths that the OS profile may read but never write for this shell run. */
  readonly readOnlyPaths?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface NativeProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly cancelled: boolean;
}

export class NativeProcessRunnerUnavailableError extends Error {
  public constructor(message = "The native process runner is unavailable on this platform.") {
    super(message);
    this.name = "NativeProcessRunnerUnavailableError";
  }
}

interface NativeProcessCompletedResponse {
  readonly v: 1;
  readonly kind: "completed";
  readonly requestId: string;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly cancelled: boolean;
}

interface NativeProcessStream {
  setEncoding(encoding: "utf8"): void;
  on(event: "data", listener: (chunk: string) => void): this;
}

interface NativeProcessChild {
  readonly pid?: number;
  readonly stdin: { end(data: string): void };
  readonly stdout: NativeProcessStream;
  readonly stderr: NativeProcessStream;
  on(event: "data", listener: (...args: readonly unknown[]) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

interface NativeProcessSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly detached?: boolean;
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
}

type NativeProcessSpawn = (
  executable: string,
  args: readonly string[],
  options: NativeProcessSpawnOptions,
) => NativeProcessChild;

export class NativeProcessRunner {
  public constructor(
    private readonly runnerExecutable: string,
    private readonly platform = process.platform,
    private readonly spawnProcess: NativeProcessSpawn = spawn as NativeProcessSpawn,
  ) {}

  public run(request: NativeProcessRequest): Promise<NativeProcessResult> {
    if (this.platform !== "darwin" && this.platform !== "win32")
      throw new NativeProcessRunnerUnavailableError();
    const targetPath = this.platform === "win32" ? path.win32 : path.posix;
    if (!targetPath.isAbsolute(this.runnerExecutable))
      throw new Error("Sandbox Runner executable must be absolute.");
    if (!targetPath.isAbsolute(request.executable) || !targetPath.isAbsolute(request.cwd))
      throw new Error("Sandbox commands require absolute executable and cwd paths.");
    if (!targetPath.isAbsolute(request.workspace))
      throw new Error("Sandbox commands require an absolute workspace path.");
    if (request.network === true && this.platform !== "darwin" && this.platform !== "win32")
      throw new Error("Sandbox command network capability is unavailable on this platform.");
    if (request.environment) assertSafeProcessEnvironment(request.environment);

    const requestId = `sandbox-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const environment = cleanChildEnvironment(
      { ...process.env, ...request.environment },
      request.activeSecrets ?? [],
    );
    assertNativeRequestMaterialSafe(request, environment);
    assertNativeRequestSize(request, requestId, environment);
    const payload = JSON.stringify({
      v: 1,
      kind: "run",
      requestId,
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      workspace: request.workspace,
      network: request.network === true,
      fullAccess: request.fullAccess === true,
      allowProcessExec: request.allowProcessExec === true,
      processExecPaths: request.processExecPaths ?? [],
      readOnlyPaths: request.readOnlyPaths ?? [],
      parentPid: process.pid,
      environment,
    });
    const activeSecretLocation = activeSecretMaterialLocation(request, environment, payload);
    const credentialShapedLocation = credentialShapedMaterialLocation(
      request,
      environment,
      payload,
    );
    if (credentialShapedLocation !== undefined || activeSecretLocation !== undefined)
      throw new Error(
        `Sandbox Runner ${activeSecretLocation ?? credentialShapedLocation}: provider credentials forbidden.`,
      );
    if (Buffer.byteLength(payload, "utf8") + 1 > MAX_PROTOCOL_LINE_BYTES)
      throw new Error("Sandbox process request exceeds the protocol size limit.");
    if (request.signal?.aborted)
      return Promise.resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        cancelled: true,
      });

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.runnerExecutable, [], {
        cwd: request.cwd,
        env: cleanChildEnvironment(process.env),
        ...(this.platform === "darwin" ? { detached: true } : {}),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let cancelled = false;
      let finished = false;
      const terminate = (): void => {
        if (child.pid === undefined) return;
        if (this.platform === "darwin") {
          try {
            process.kill(-child.pid, "SIGTERM");
            return;
          } catch {
            // Fall through to the direct child termination path.
          }
        }
        child.kill();
      };
      const onAbort = (): void => {
        cancelled = true;
        terminate();
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = appendBoundedOutput(stdout, chunk, MAX_RESPONSE_BYTES);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = appendBoundedOutput(stderr, chunk);
      });
      child.once("error", (error) => {
        finished = true;
        request.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.once("close", (code, signal) => {
        finished = true;
        request.signal?.removeEventListener("abort", onAbort);
        if (cancelled) {
          resolve({ code, signal, stdout: "", stderr: "", cancelled: true });
          return;
        }
        try {
          const response = parseNativeProcessResponse(stdout, requestId);
          resolve({
            code: response.code,
            signal,
            stdout: response.stdout,
            stderr: response.stderr,
            cancelled: response.cancelled,
          });
        } catch (error) {
          reject(error);
        }
      });
      if (request.signal?.aborted) onAbort();
      if (!finished) child.stdin.end(`${payload}\n`);
    });
  }
}

export interface NativeProcessRunnerPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly exists?: (candidate: string) => boolean;
}

export function resolveNativeProcessRunnerPath(
  moduleUrl: string,
  options: NativeProcessRunnerPathOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") return undefined;
  const environment = options.environment ?? process.env;
  const workingDirectory = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const targetPath = platform === "win32" ? path.win32 : path.posix;
  const nativeName = platform === "win32" ? "candy-sandbox-runner.exe" : "candy-sandbox-runner";
  const explicitOverride = environment.CANDY_SANDBOX_RUNNER;
  if (explicitOverride !== undefined) {
    return targetPath.isAbsolute(explicitOverride) && exists(explicitOverride)
      ? explicitOverride
      : undefined;
  }
  const moduleDirectory = resolveModuleDirectory(moduleUrl, platform);
  if (moduleDirectory === undefined) return undefined;
  const candidates = [
    targetPath.resolve(moduleDirectory, `../native/${nativeName}`),
    targetPath.resolve(workingDirectory, `native/sandbox-runner/target/debug/${nativeName}`),
    targetPath.resolve(workingDirectory, `../../native/sandbox-runner/target/debug/${nativeName}`),
  ];
  return candidates.find(
    (candidate): candidate is string => targetPath.isAbsolute(candidate) && exists(candidate),
  );
}

function resolveModuleDirectory(
  moduleUrl: string,
  platform: "darwin" | "win32",
): string | undefined {
  try {
    const url = new URL(moduleUrl);
    if (url.protocol !== "file:") return undefined;
    if (platform === "win32") {
      const pathname = decodeURIComponent(url.pathname).replaceAll("/", "\\");
      const modulePath = url.hostname
        ? `\\\\${url.hostname}${pathname}`
        : /^[\\/]\p{L}:/u.test(pathname)
          ? pathname.slice(1)
          : pathname;
      return path.win32.dirname(modulePath);
    }
    return path.posix.dirname(decodeURIComponent(url.pathname));
  } catch {
    return undefined;
  }
}

export interface ProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly activeSecrets?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly cancelled: boolean;
}

export class ProcessSupervisorUnavailableError extends Error {
  public constructor(message = "Strong process supervision is unavailable on this platform.") {
    super(message);
    this.name = "ProcessSupervisorUnavailableError";
  }
}

/** Legacy shell-free process seam retained outside Runtime for native/process isolation. */
export class ProcessSupervisor {
  public constructor(private readonly platform = process.platform) {}

  public run(request: ProcessRequest): Promise<ProcessResult> {
    if (this.platform === "win32") throw new ProcessSupervisorUnavailableError();
    if (path.isAbsolute(request.executable) === false)
      throw new Error("Supervised executables must use an absolute path.");
    assertSafeProcessEnvironment(request.environment ?? {});
    const environment = cleanChildEnvironment(
      { ...process.env, ...request.environment },
      request.activeSecrets ?? [],
    );
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: environment,
        detached: true,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let cancelled = false;
      let finished = false;
      const terminate = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      };
      const onAbort = (): void => {
        cancelled = true;
        terminate("SIGTERM");
        setTimeout(() => {
          if (!finished) terminate("SIGKILL");
        }, 1_000).unref();
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = appendBoundedOutput(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = appendBoundedOutput(stderr, chunk);
      });
      child.once("error", (error) => {
        finished = true;
        request.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.once("close", (code, signal) => {
        finished = true;
        request.signal?.removeEventListener("abort", onAbort);
        resolve({ code, signal, stdout, stderr, cancelled });
      });
      if (request.signal?.aborted) onAbort();
    });
  }
}

function parseNativeProcessResponse(
  value: string,
  expectedRequestId: string,
): NativeProcessCompletedResponse {
  const line = value.split(/\r?\n/u).find((candidate) => candidate.length > 0);
  if (line === undefined) throw new Error("Sandbox Runner returned no response.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Sandbox Runner returned malformed JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { readonly kind?: unknown }).kind !== "completed"
  ) {
    const code =
      typeof parsed === "object" && parsed !== null && "code" in parsed
        ? String((parsed as { readonly code?: unknown }).code)
        : "unknown";
    throw new Error(`Sandbox Runner rejected the validator request (${code}).`);
  }
  const response = parsed as Partial<NativeProcessCompletedResponse>;
  if (
    response.v !== 1 ||
    response.requestId !== expectedRequestId ||
    (typeof response.code !== "number" && response.code !== null) ||
    typeof response.stdout !== "string" ||
    typeof response.stderr !== "string" ||
    typeof response.cancelled !== "boolean"
  ) {
    throw new Error("Sandbox Runner returned an invalid response.");
  }
  return response as NativeProcessCompletedResponse;
}

function appendBoundedOutput(
  current: string,
  chunk: string,
  maximumBytes = MAX_OUTPUT_BYTES,
): string {
  const remainingBytes = maximumBytes - Buffer.byteLength(current, "utf8");
  if (remainingBytes <= 0) return current;
  if (Buffer.byteLength(chunk, "utf8") <= remainingBytes) return current + chunk;
  return current + Buffer.from(chunk, "utf8").subarray(0, remainingBytes).toString("utf8");
}

function assertSafeProcessEnvironment(environment: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(environment)) {
    if (/(?:api[_-]?key|authorization|credential|password|secret|token)/iu.test(key))
      throw new Error("Provider credentials are forbidden in supervised process environments.");
    if (containsCredentialMaterial(value))
      throw new Error("Secret-shaped content is forbidden in supervised process environments.");
  }
}

function assertNativeRequestSize(
  request: NativeProcessRequest,
  requestId: string,
  environment: NodeJS.ProcessEnv,
): void {
  let bytes = 2;
  let fields = 0;
  const addField = (name: string, valueBytes: number): void => {
    bytes += (fields === 0 ? 0 : 1) + jsonStringByteLength(name) + 1 + valueBytes;
    fields += 1;
  };
  addField("v", 1);
  addField("kind", jsonStringByteLength("run"));
  addField("requestId", jsonStringByteLength(requestId));
  addField("executable", jsonStringByteLength(request.executable));
  addField("args", jsonArrayByteLength(request.args));
  addField("cwd", jsonStringByteLength(request.cwd));
  addField("workspace", jsonStringByteLength(request.workspace));
  addField("network", request.network === true ? 4 : 5);
  addField("fullAccess", request.fullAccess === true ? 4 : 5);
  addField("allowProcessExec", request.allowProcessExec === true ? 4 : 5);
  addField("processExecPaths", jsonArrayByteLength(request.processExecPaths ?? []));
  addField("readOnlyPaths", jsonArrayByteLength(request.readOnlyPaths ?? []));
  addField("parentPid", String(process.pid).length);
  addField("environment", jsonEnvironmentByteLength(environment));
  if (bytes > MAX_NATIVE_REQUEST_BYTES)
    throw new Error("Sandbox process request exceeds the protocol size limit.");
}

function assertNativeRequestMaterialSafe(
  request: NativeProcessRequest,
  environment: NodeJS.ProcessEnv,
): void {
  const values: readonly (readonly [string, string])[] = [
    ["executable", request.executable],
    ...request.args.map((value): readonly [string, string] => ["argument", value]),
    ["cwd", request.cwd],
    ["workspace", request.workspace],
    ...(request.processExecPaths?.map((value): readonly [string, string] => [
      "process executable path",
      value,
    ]) ?? []),
    ...(request.readOnlyPaths?.map((value): readonly [string, string] => [
      "read-only path",
      value,
    ]) ?? []),
    ...environmentEntries(request.environment ?? {}).map((value): readonly [string, string] => [
      "request environment",
      value,
    ]),
    ...environmentEntries(environment).map((value): readonly [string, string] => [
      "child environment",
      value,
    ]),
  ];
  const activeSecretLocation = values.find(([, value]) =>
    containsActiveSecretMaterial(value, request.activeSecrets ?? []),
  )?.[0];
  const credentialShapedLocation = values.find(([, value]) =>
    containsCredentialMaterial(value),
  )?.[0];
  if (credentialShapedLocation !== undefined || activeSecretLocation !== undefined)
    throw new Error(
      `Sandbox Runner ${activeSecretLocation ?? credentialShapedLocation}: provider credentials forbidden.`,
    );
}

function jsonArrayByteLength(values: readonly string[]): number {
  return (
    2 +
    values.reduce((total, value) => total + jsonStringByteLength(value), 0) +
    Math.max(0, values.length - 1)
  );
}

function jsonEnvironmentByteLength(environment: NodeJS.ProcessEnv): number {
  const entries = Object.entries(environment).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return (
    2 +
    entries.reduce(
      (total, [key, value]) => total + jsonStringByteLength(key) + 1 + jsonStringByteLength(value),
      0,
    ) +
    Math.max(0, entries.length - 1)
  );
}

function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code < 0x20 || code === 0x2028 || code === 0x2029) {
      bytes += 6;
    } else if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function activeSecretMaterialLocation(
  request: NativeProcessRequest,
  environment: NodeJS.ProcessEnv,
  payload: string,
): string | undefined {
  const values: readonly (readonly [string, string])[] = [
    ["executable", request.executable],
    ...request.args.map((value): readonly [string, string] => ["argument", value]),
    ["cwd", request.cwd],
    ["workspace", request.workspace],
    ...environmentEntries(request.environment ?? {}).map((value): readonly [string, string] => [
      "request environment",
      value,
    ]),
    ...environmentEntries(environment).map((value): readonly [string, string] => [
      "child environment",
      value,
    ]),
    ["serialized payload", payload],
  ];
  const activeSecrets = request.activeSecrets ?? [];
  return values.find(([, value]) => containsActiveSecretMaterial(value, activeSecrets))?.[0];
}

function credentialShapedMaterialLocation(
  request: NativeProcessRequest,
  environment: NodeJS.ProcessEnv,
  payload: string,
): string | undefined {
  const values: readonly (readonly [string, string])[] = [
    ["executable", request.executable],
    ...request.args.map((value): readonly [string, string] => ["argument", value]),
    ["cwd", request.cwd],
    ["workspace", request.workspace],
    ...environmentEntries(request.environment ?? {}).map((value): readonly [string, string] => [
      "request environment",
      value,
    ]),
    ...environmentEntries(environment).map((value): readonly [string, string] => [
      "child environment",
      value,
    ]),
    ["serialized payload", payload],
  ];
  return values.find(([, value]) => containsCredentialMaterial(value))?.[0];
}

function environmentEntries(environment: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(environment).flatMap(([key, value]) =>
    value === undefined ? [key] : [key, value],
  );
}

function containsActiveSecretMaterial(value: string, activeSecrets: readonly string[]): boolean {
  return activeSecrets.some((secret) => {
    if (secret.length === 0) return false;
    if (value.includes(secret)) return true;
    if (Buffer.byteLength(secret, "utf8") > MAX_PROTOCOL_LINE_BYTES) return false;
    let representation = JSON.stringify(secret);
    while (Buffer.byteLength(representation, "utf8") <= MAX_PROTOCOL_LINE_BYTES) {
      if (value.includes(representation)) return true;
      const nextRepresentation = JSON.stringify(representation);
      if (Buffer.byteLength(nextRepresentation, "utf8") > MAX_PROTOCOL_LINE_BYTES) break;
      representation = nextRepresentation;
    }
    return false;
  });
}
