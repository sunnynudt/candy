import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "./index.js";

const MAX_OUTPUT_BYTES = 1_048_576;

export interface NativeProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly workspace: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly activeSecrets?: readonly string[];
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

export class NativeProcessRunner {
  public constructor(
    private readonly runnerExecutable: string,
    private readonly platform = process.platform,
  ) {}

  public run(request: NativeProcessRequest): Promise<NativeProcessResult> {
    if (this.platform !== "darwin" && this.platform !== "win32")
      throw new NativeProcessRunnerUnavailableError();
    if (!path.isAbsolute(this.runnerExecutable))
      throw new Error("Sandbox Runner executable must be absolute.");
    if (!path.isAbsolute(request.executable) || !path.isAbsolute(request.cwd))
      throw new Error("Sandbox commands require absolute executable and cwd paths.");
    if (!path.isAbsolute(request.workspace))
      throw new Error("Sandbox commands require an absolute workspace path.");
    if (request.environment) assertSafeProcessEnvironment(request.environment);

    const requestId = `sandbox-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const environment = cleanChildEnvironment(
      { ...process.env, ...request.environment },
      request.activeSecrets ?? [],
    );
    const payload = JSON.stringify({
      v: 1,
      kind: "run",
      requestId,
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      workspace: request.workspace,
      network: false,
      environment,
    });
    if (containsSandboxSecretMaterial(payload))
      throw new Error("Provider credentials are forbidden in Sandbox Runner requests.");

    return new Promise((resolve, reject) => {
      const child = spawn(this.runnerExecutable, [], {
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
        child.kill("SIGTERM");
      };
      const onAbort = (): void => {
        cancelled = true;
        terminate();
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = appendBoundedOutput(stdout, chunk);
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
  const nativeName = platform === "win32" ? "candy-sandbox-runner.exe" : "candy-sandbox-runner";
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    environment.CANDY_SANDBOX_RUNNER,
    path.resolve(moduleDirectory, `../native/${nativeName}`),
    path.resolve(workingDirectory, `native/sandbox-runner/target/debug/${nativeName}`),
    path.resolve(workingDirectory, `../../native/sandbox-runner/target/debug/${nativeName}`),
  ];
  return candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined && path.isAbsolute(candidate) && exists(candidate),
  );
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
    throw new Error("Sandbox Runner rejected the validator request.");
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

function appendBoundedOutput(current: string, chunk: string): string {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  return current + chunk.slice(0, MAX_OUTPUT_BYTES - current.length);
}

function assertSafeProcessEnvironment(environment: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(environment)) {
    if (/(?:api[_-]?key|authorization|credential|password|secret|token)/iu.test(key))
      throw new Error("Provider credentials are forbidden in supervised process environments.");
    if (containsSandboxSecretMaterial(value))
      throw new Error("Secret-shaped content is forbidden in supervised process environments.");
  }
}

function containsSandboxSecretMaterial(value: string): boolean {
  return /(?:Bearer\s+|sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._~+/=-]{16,}/u.test(value);
}
