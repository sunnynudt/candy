import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanChildEnvironment } from "@candy/platform";

export type ActionKind =
  | "workspace.read"
  | "workspace.write"
  | "shell"
  | "git.publish"
  | "browser.observe"
  | "browser.navigate"
  | "browser.sensitive";

export type ApprovalDecision = "allow" | "require_approval" | "deny" | "unsupported";
export type ApprovalProfile = "read-only" | "auto";

export interface ActionRequest {
  readonly kind: ActionKind;
  readonly network: boolean;
  readonly destructive: boolean;
  readonly outsideWorkspace: boolean;
  readonly mutable: boolean;
}

export class ApprovalPolicy {
  public constructor(
    private readonly profile: ApprovalProfile,
    private readonly shellEnabled = false,
  ) {}

  public decide(action: ActionRequest): ApprovalDecision {
    if (action.kind === "workspace.read" || action.kind === "browser.observe") {
      return action.outsideWorkspace ? "deny" : "allow";
    }
    if (action.kind === "shell" && !this.shellEnabled) return "unsupported";
    if (this.profile === "read-only" && action.mutable) return "deny";
    if (
      action.network ||
      action.destructive ||
      action.outsideWorkspace ||
      action.kind === "git.publish"
    ) {
      return "require_approval";
    }
    return action.mutable ? "require_approval" : "allow";
  }
}

export class SerialMutationLane {
  #tail: Promise<void> = Promise.resolve();

  public run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class ProviderConcurrencyGate {
  #active = 0;
  readonly #waiters: (() => void)[] = [];

  public constructor(
    public readonly provider: "deepseek" | "minimax-cn",
    private readonly limit: number,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Provider concurrency must be positive.");
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#waiters.shift()?.();
    }
  }

  public get active(): number {
    return this.#active;
  }

  private acquire(): Promise<void> {
    if (this.#active < this.limit) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.#waiters.push(() => {
        this.#active += 1;
        resolve();
      }),
    );
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

/** Narrow, shell-free process seam. Windows remains unavailable until Job Object G2 passes. */
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
      child.stdout?.on(
        "data",
        (chunk: string) => (stdout += chunk.slice(0, 1_048_576 - stdout.length)),
      );
      child.stderr?.on(
        "data",
        (chunk: string) => (stderr += chunk.slice(0, 1_048_576 - stderr.length)),
      );
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

function assertSafeProcessEnvironment(environment: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(environment)) {
    if (/(?:api[_-]?key|authorization|credential|password|secret|token)/iu.test(key))
      throw new Error("Provider credentials are forbidden in supervised process environments.");
    if (/(?:Bearer\s+|sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._~+/=-]{16,}/u.test(value))
      throw new Error("Secret-shaped content is forbidden in supervised process environments.");
  }
}

export interface AttachmentMetadata {
  readonly id: string;
  readonly kind: "image" | "video";
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly createdAt: number;
}

export interface ImageAttachmentPayload {
  readonly id: string;
  readonly mimeType: string;
  readonly data: string;
}

export class AttachmentStore {
  public constructor(
    private readonly root: string,
    private readonly clock: () => number = Date.now,
  ) {}

  public async put(
    kind: "image" | "video",
    mimeType: string,
    content: Uint8Array,
  ): Promise<AttachmentMetadata> {
    if (kind === "video")
      throw new Error("Video input is unavailable until its provider gate passes.");
    if (!mimeType.startsWith("image/"))
      throw new Error("Image attachments require an image MIME type.");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const id = `att_${sha256}`;
    await mkdir(this.root, { recursive: true });
    await writeFile(path.join(this.root, `${id}.bin`), content, { flag: "wx" }).catch(
      (error: unknown) => {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      },
    );
    const metadata: AttachmentMetadata = {
      id,
      kind,
      mimeType,
      bytes: content.byteLength,
      sha256,
      createdAt: this.clock(),
    };
    await writeFile(path.join(this.root, `${id}.json`), JSON.stringify(metadata), { flag: "w" });
    return metadata;
  }

  public async get(
    id: string,
  ): Promise<{ readonly metadata: AttachmentMetadata; readonly content: Uint8Array }> {
    if (!/^att_[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid attachment id.");
    const metadata = JSON.parse(
      await readFile(path.join(this.root, `${id}.json`), "utf8"),
    ) as AttachmentMetadata;
    const content = await readFile(path.join(this.root, `${id}.bin`));
    if (
      metadata.id !== id ||
      metadata.kind !== "image" ||
      !metadata.mimeType.startsWith("image/") ||
      metadata.bytes !== content.byteLength ||
      metadata.sha256 !== createHash("sha256").update(content).digest("hex")
    ) {
      throw new Error("Attachment integrity check failed.");
    }
    return { metadata, content };
  }

  public async getImagePayload(id: string): Promise<ImageAttachmentPayload> {
    const attachment = await this.get(id);
    if (attachment.metadata.kind !== "image")
      throw new Error("Only image attachments can be sent to a multimodal model.");
    return {
      id,
      mimeType: attachment.metadata.mimeType,
      data: Buffer.from(attachment.content).toString("base64"),
    };
  }

  public async cleanupBefore(cutoff: number): Promise<number> {
    let removed = 0;
    for (const entry of await readdir(this.root).catch(() => [] as string[])) {
      if (!entry.endsWith(".json")) continue;
      const metadata = JSON.parse(
        await readFile(path.join(this.root, entry), "utf8"),
      ) as AttachmentMetadata;
      if (metadata.createdAt < cutoff) {
        await rm(path.join(this.root, `${metadata.id}.json`), { force: true });
        await rm(path.join(this.root, `${metadata.id}.bin`), { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}

export interface BrowserTabSnapshot {
  readonly tabId: string;
  readonly revision: number;
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly control: "user" | "agent";
  readonly siteAllowed: boolean;
}

export type BrowserAction =
  | { readonly type: "navigate"; readonly url: string; readonly expectedRevision: number }
  | { readonly type: "click"; readonly target: string; readonly expectedRevision: number }
  | {
      readonly type: "type";
      readonly target: string;
      readonly text: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "submit";
      readonly target: string;
      readonly expectedRevision: number;
      readonly confirmed: boolean;
    };

export class BrowserRevisionError extends Error {}
export class BrowserControlError extends Error {}

/** Deterministic Browser Workspace model; Electron implementation stays behind this seam. */
export class InMemoryBrowserWorkspace {
  readonly #tabs = new Map<string, BrowserTabSnapshot>();
  readonly #allowedHosts = new Set<string>();
  #nextTab = 1;

  public allowSite(host: string): void {
    this.#allowedHosts.add(host.toLowerCase());
  }

  public open(url: string): BrowserTabSnapshot {
    const parsed = new URL(url);
    const tabId = `tab-${this.#nextTab++}`;
    const snapshot: BrowserTabSnapshot = {
      tabId,
      revision: 1,
      url,
      title: "",
      text: "",
      control: "agent",
      siteAllowed: this.#allowedHosts.has(parsed.host.toLowerCase()),
    };
    this.#tabs.set(tabId, snapshot);
    return snapshot;
  }

  public observe(tabId: string): BrowserTabSnapshot {
    const tab = this.#tabs.get(tabId);
    if (!tab) throw new Error("Unknown browser tab.");
    return { ...tab };
  }

  public act(tabId: string, action: BrowserAction): BrowserTabSnapshot {
    const current = this.observe(tabId);
    if (current.control !== "agent") throw new BrowserControlError("User owns this browser tab.");
    if (!current.siteAllowed) throw new BrowserControlError("Site permission is required.");
    if (action.expectedRevision !== current.revision)
      throw new BrowserRevisionError("Browser observation is stale.");
    if (action.type === "submit" && !action.confirmed)
      throw new BrowserControlError("Sensitive browser action requires confirmation.");
    const next: BrowserTabSnapshot = {
      ...current,
      revision: current.revision + 1,
      url: action.type === "navigate" ? action.url : current.url,
      text: action.type === "type" ? `${current.text}${action.text}` : current.text,
      siteAllowed:
        action.type === "navigate"
          ? this.#allowedHosts.has(new URL(action.url).host.toLowerCase())
          : current.siteAllowed,
    };
    this.#tabs.set(tabId, next);
    return next;
  }

  public takeControl(tabId: string): BrowserTabSnapshot {
    const current = this.observe(tabId);
    const next = { ...current, control: "user" as const, revision: current.revision + 1 };
    this.#tabs.set(tabId, next);
    return next;
  }

  public returnControlToAgent(tabId: string): BrowserTabSnapshot {
    const current = this.observe(tabId);
    const next = { ...current, control: "agent" as const, revision: current.revision + 1 };
    this.#tabs.set(tabId, next);
    return next;
  }
}

export interface ValidatorResult {
  readonly ok: boolean;
  readonly fingerprint: string;
  readonly evidence: string;
  readonly durationMs: number;
}

export interface Validator {
  run(signal: AbortSignal): Promise<ValidatorResult>;
}

export class FixedValidator implements Validator {
  public constructor(private readonly result: ValidatorResult) {}

  public async run(signal: AbortSignal): Promise<ValidatorResult> {
    if (signal.aborted)
      throw signal.reason instanceof Error ? signal.reason : new Error("Validator cancelled.");
    return this.result;
  }
}

export type LongRunningStopReason =
  | "validator_succeeded"
  | "budget_exhausted"
  | "stall_detected"
  | "cancelled"
  | "approval_required"
  | "ownership_lost"
  | "provider_failure"
  | "user_stop"
  | "crash_interrupted"
  | "error";

export class LongRunningControlError extends Error {
  public constructor(
    public readonly stopReason: Exclude<
      LongRunningStopReason,
      "validator_succeeded" | "budget_exhausted" | "stall_detected" | "error"
    >,
  ) {
    super(`Long-running task stopped: ${stopReason}.`);
    this.name = "LongRunningControlError";
  }
}

export interface LongRunningResult {
  readonly completed: boolean;
  readonly stopReason: LongRunningStopReason;
  readonly rounds: number;
  readonly evidence: readonly ValidatorResult[];
}

export interface LongRunningProgress {
  readonly rounds: number;
  readonly evidenceCount: number;
  readonly completed: boolean;
  readonly stopReason:
    | "running"
    | "validator_succeeded"
    | "budget_exhausted"
    | "stall_detected"
    | "cancelled"
    | "approval_required"
    | "ownership_lost"
    | "provider_failure"
    | "user_stop"
    | "crash_interrupted"
    | "error";
  readonly lastFingerprintHash?: string;
}

export interface LongRunningProgressStore {
  record(progress: LongRunningProgress): void;
}

export interface LongRunningProgressBinding {
  readonly store: LongRunningProgressStore;
}

export class LongRunningTaskRunner {
  public constructor(
    private readonly maxRounds: number,
    private readonly stallLimit = 2,
  ) {}

  public async run(
    turn: (round: number, signal: AbortSignal) => Promise<void>,
    validator: Validator,
    signal: AbortSignal,
    progress?: LongRunningProgressBinding,
  ): Promise<LongRunningResult> {
    const evidence: ValidatorResult[] = [];
    let unchanged = 0;
    for (let round = 1; round <= this.maxRounds; round += 1) {
      if (signal.aborted) {
        const stopReason = stopReasonFromSignal(signal);
        persistProgress(progress, {
          rounds: round - 1,
          evidenceCount: evidence.length,
          completed: false,
          stopReason,
        });
        return { completed: false, stopReason, rounds: round - 1, evidence };
      }
      try {
        await turn(round, signal);
        const result = await validator.run(signal);
        const previous = evidence.at(-1);
        unchanged = previous?.fingerprint === result.fingerprint ? unchanged + 1 : 0;
        evidence.push(result);
        const fingerprintHash = createHash("sha256").update(result.fingerprint).digest("hex");
        if (result.ok) {
          persistProgress(progress, {
            rounds: round,
            evidenceCount: evidence.length,
            completed: true,
            stopReason: "validator_succeeded",
            lastFingerprintHash: fingerprintHash,
          });
          return { completed: true, stopReason: "validator_succeeded", rounds: round, evidence };
        }
        if (unchanged >= this.stallLimit) {
          persistProgress(progress, {
            rounds: round,
            evidenceCount: evidence.length,
            completed: false,
            stopReason: "stall_detected",
            lastFingerprintHash: fingerprintHash,
          });
          return { completed: false, stopReason: "stall_detected", rounds: round, evidence };
        }
        persistProgress(progress, {
          rounds: round,
          evidenceCount: evidence.length,
          completed: false,
          stopReason: "running",
          lastFingerprintHash: fingerprintHash,
        });
      } catch (error) {
        const stopReason = signal.aborted
          ? stopReasonFromSignal(signal)
          : stopReasonFromError(error);
        persistProgress(progress, {
          rounds: round,
          evidenceCount: evidence.length,
          completed: false,
          stopReason,
        });
        return { completed: false, stopReason, rounds: round, evidence };
      }
    }
    persistProgress(progress, {
      rounds: this.maxRounds,
      evidenceCount: evidence.length,
      completed: false,
      stopReason: "budget_exhausted",
    });
    return { completed: false, stopReason: "budget_exhausted", rounds: this.maxRounds, evidence };
  }
}

function stopReasonFromSignal(
  signal: AbortSignal,
): Exclude<
  LongRunningStopReason,
  "validator_succeeded" | "budget_exhausted" | "stall_detected" | "error"
> {
  return signal.reason instanceof LongRunningControlError ? signal.reason.stopReason : "cancelled";
}

function stopReasonFromError(error: unknown): LongRunningStopReason {
  return error instanceof LongRunningControlError ? error.stopReason : "error";
}

function persistProgress(
  binding: LongRunningProgressBinding | undefined,
  progress: LongRunningProgress,
): void {
  binding?.store.record(progress);
}

export interface ApplyChangesInput {
  readonly targetIsGit: boolean;
  readonly targetClean: boolean;
  readonly expectedBase: string;
  readonly actualBase: string;
  readonly paths: readonly string[];
  readonly patchText: string;
  readonly activeSecrets: readonly string[];
}

export class ApplyChangesGuard {
  public constructor(private readonly targetRoot: string) {}

  public check(input: ApplyChangesInput): "allow" | "blocked" {
    if (!input.targetIsGit || !input.targetClean || input.expectedBase !== input.actualBase)
      return "blocked";
    for (const requested of input.paths) {
      const absolute = path.resolve(this.targetRoot, requested);
      const relative = path.relative(path.resolve(this.targetRoot), absolute);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return "blocked";
    }
    if (input.activeSecrets.some((secret) => secret.length > 0 && input.patchText.includes(secret)))
      return "blocked";
    return "allow";
  }
}

export interface GitChangeManifest {
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
}

export interface GitCommandRunner {
  run(args: readonly string[], cwd: string, input?: string): Promise<string>;
}

class NodeGitCommandRunner implements GitCommandRunner {
  public run(args: readonly string[], cwd: string, input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", [...args], {
        cwd,
        env: cleanChildEnvironment(process.env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`git ${args[0] ?? "command"} failed: ${stderr.trim()}`));
      });
      child.stdin.end(input);
    });
  }
}

export class GitWorktreeManager {
  readonly #runner: GitCommandRunner;

  public constructor(
    private readonly worktreeRoot: string,
    runner: GitCommandRunner = new NodeGitCommandRunner(),
  ) {
    this.#runner = runner;
  }

  public async create(plan: GitWorktreePlan): Promise<void> {
    this.assertWorktreePath(plan.worktreePath);
    await mkdir(path.dirname(path.resolve(plan.worktreePath)), { recursive: true });
    await this.#runner.run(plan.createArgs, plan.repository);
    await this.inspect(plan);
  }

  public async inspect(plan: GitWorktreePlan): Promise<string> {
    const listing = await this.#runner.run(plan.inspectArgs, plan.repository);
    if (!listing.includes(plan.worktreePath) || !listing.includes(`candy:${plan.taskId}`))
      throw new Error("Git worktree association could not be verified.");
    return listing;
  }

  public async unlock(plan: GitWorktreePlan): Promise<void> {
    await this.#runner.run(plan.unlockArgs, plan.repository);
  }

  public async removeClean(plan: GitWorktreePlan): Promise<void> {
    const status = await this.#runner.run(["status", "--porcelain=v1", "-z"], plan.worktreePath);
    if (status.length > 0) throw new Error("Dirty worktrees cannot be removed automatically.");
    await this.#runner.run(plan.removeArgs, plan.repository);
  }

  public async changes(
    plan: GitWorktreePlan,
  ): Promise<GitChangeManifest & { readonly patchText: string }> {
    const tracked = splitNull(
      await this.#runner.run(
        ["diff", "--name-only", "--no-ext-diff", "-z", plan.baseCommit, "--"],
        plan.worktreePath,
      ),
    );
    const untracked = splitNull(
      await this.#runner.run(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        plan.worktreePath,
      ),
    );
    const patchText = await this.#runner.run(
      ["diff", "--binary", "--no-ext-diff", "--no-color", plan.baseCommit, "--"],
      plan.worktreePath,
    );
    return { tracked, untracked, patchText };
  }

  private assertWorktreePath(worktreePath: string): void {
    const root = path.resolve(this.worktreeRoot);
    const candidate = path.resolve(worktreePath);
    const relative = path.relative(root, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Task worktree is outside Candy's worktree root.");
  }
}

export class ApplyChangesBlockedError extends Error {
  public constructor(message = "Apply Changes was blocked by a preflight check.") {
    super(message);
    this.name = "ApplyChangesBlockedError";
  }
}

export class ApplyChangesService {
  readonly #guard: ApplyChangesGuard;
  readonly #runner: GitCommandRunner;

  public constructor(
    private readonly targetRoot: string,
    runner: GitCommandRunner = new NodeGitCommandRunner(),
  ) {
    this.#guard = new ApplyChangesGuard(targetRoot);
    this.#runner = runner;
  }

  public async apply(sourceRoot: string, input: ApplyChangesInput): Promise<"applied"> {
    const targetRoot = path.resolve(this.targetRoot);
    let actualBase: string;
    let targetStatus: string;
    try {
      actualBase = (await this.#runner.run(["rev-parse", "HEAD"], targetRoot)).trim();
      targetStatus = await this.#runner.run(["status", "--porcelain=v1", "-z"], targetRoot);
    } catch {
      throw new ApplyChangesBlockedError("Apply Changes requires a valid Git target.");
    }
    const effective = {
      ...input,
      targetIsGit: true,
      targetClean: targetStatus.length === 0,
      actualBase,
    };
    if (this.#guard.check(effective) === "blocked") throw new ApplyChangesBlockedError();

    const paths = uniqueRelativePaths(input.paths);
    const source = path.resolve(sourceRoot);
    for (const requested of paths) {
      await assertSafePath(source, requested, true);
      await assertSafePath(targetRoot, requested, false);
    }
    const untrackedPaths: string[] = [];
    for (const requested of paths) {
      const isUntracked = Boolean(
        (
          await this.#runner.run(
            ["ls-files", "--others", "--exclude-standard", "--", requested],
            source,
          )
        ).trim(),
      );
      if (!isUntracked) continue;
      untrackedPaths.push(requested);
      try {
        await lstat(path.resolve(targetRoot, requested));
        throw new ApplyChangesBlockedError(
          "Target already contains an untracked Apply Changes path.",
        );
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
    if (input.patchText.length > 0) {
      try {
        await this.#runner.run(
          ["apply", "--check", "--binary", "--whitespace=nowarn", "--"],
          targetRoot,
          input.patchText,
        );
        await this.#runner.run(
          ["apply", "--binary", "--whitespace=nowarn", "--"],
          targetRoot,
          input.patchText,
        );
      } catch (error) {
        throw new ApplyChangesBlockedError(
          `Git refused the reviewed patch: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    for (const requested of untrackedPaths) {
      const sourcePath = path.resolve(source, requested);
      const targetPath = path.resolve(targetRoot, requested);
      await mkdir(path.dirname(targetPath), { recursive: true });
      const content = await readFile(sourcePath);
      await writeFile(targetPath, content, { flag: "wx" });
    }
    return "applied";
  }
}

export interface GitWorktreePlan {
  readonly taskId: string;
  readonly repository: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly createArgs: readonly string[];
  readonly inspectArgs: readonly string[];
  readonly unlockArgs: readonly string[];
  readonly removeArgs: readonly string[];
}

/** Argument-array-only Git seam; execution and user confirmation remain outside this module. */
export function planGitWorktree(
  repository: string,
  worktreePath: string,
  taskId: string,
  baseCommit: string,
): GitWorktreePlan {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(taskId))
    throw new Error("Task id is not safe for worktree association.");
  if (!/^[0-9a-f]{7,64}$/u.test(baseCommit))
    throw new Error("Worktree base must be a Git commit id.");
  return {
    taskId,
    repository,
    worktreePath,
    baseCommit,
    createArgs: [
      "worktree",
      "add",
      "--detach",
      "--lock",
      "--reason",
      `candy:${taskId}`,
      worktreePath,
      baseCommit,
    ],
    inspectArgs: ["worktree", "list", "--porcelain", "-z"],
    unlockArgs: ["worktree", "unlock", worktreePath],
    removeArgs: ["worktree", "remove", worktreePath],
  };
}

export type HandoffState = "local" | "worktree" | "applying" | "blocked";

export class WorkspaceHandoff {
  #state: HandoffState = "local";

  public get state(): HandoffState {
    return this.#state;
  }

  public startWorktree(): void {
    if (this.#state !== "local") throw new Error("Workspace is not in Local state.");
    this.#state = "worktree";
  }

  public beginApply(guard: "allow" | "blocked"): void {
    if (this.#state !== "worktree") throw new Error("Only a Task Worktree can be applied.");
    this.#state = guard === "allow" ? "applying" : "blocked";
  }

  public finishApply(): void {
    if (this.#state !== "applying") throw new Error("Apply Changes is not in progress.");
    this.#state = "local";
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function splitNull(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function uniqueRelativePaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  for (const requested of unique) {
    if (requested.length === 0 || path.isAbsolute(requested))
      throw new ApplyChangesBlockedError("Apply Changes contains an invalid path.");
    const normalized = path.normalize(requested);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`))
      throw new ApplyChangesBlockedError("Apply Changes contains an escaping path.");
  }
  return unique;
}

async function assertSafePath(
  root: string,
  requested: string,
  requireLeaf: boolean,
): Promise<void> {
  const absolute = path.resolve(root, requested);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new ApplyChangesBlockedError("Apply Changes path escaped its source workspace.");
  const segments = relative.split(path.sep);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new ApplyChangesBlockedError("Symlinked Apply Changes paths are blocked.");
    } catch (error) {
      if (
        isNodeError(error) &&
        error.code === "ENOENT" &&
        (!requireLeaf || index === segments.length - 1)
      )
        return;
      if (isNodeError(error) && error.code === "ENOENT")
        throw new ApplyChangesBlockedError("Apply Changes source path is missing.");
      throw error;
    }
  }
}
