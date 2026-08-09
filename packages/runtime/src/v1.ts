import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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

export interface AttachmentMetadata {
  readonly id: string;
  readonly kind: "image" | "video";
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly createdAt: number;
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
    return { metadata, content: await readFile(path.join(this.root, `${id}.bin`)) };
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
  "validator_succeeded" | "budget_exhausted" | "stall_detected" | "cancelled" | "error";

export interface LongRunningResult {
  readonly completed: boolean;
  readonly stopReason: LongRunningStopReason;
  readonly rounds: number;
  readonly evidence: readonly ValidatorResult[];
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
  ): Promise<LongRunningResult> {
    const evidence: ValidatorResult[] = [];
    let unchanged = 0;
    for (let round = 1; round <= this.maxRounds; round += 1) {
      if (signal.aborted)
        return { completed: false, stopReason: "cancelled", rounds: round - 1, evidence };
      try {
        await turn(round, signal);
        const result = await validator.run(signal);
        const previous = evidence.at(-1);
        unchanged = previous?.fingerprint === result.fingerprint ? unchanged + 1 : 0;
        evidence.push(result);
        if (result.ok)
          return { completed: true, stopReason: "validator_succeeded", rounds: round, evidence };
        if (unchanged >= this.stallLimit)
          return { completed: false, stopReason: "stall_detected", rounds: round, evidence };
      } catch {
        return { completed: false, stopReason: "error", rounds: round, evidence };
      }
    }
    return { completed: false, stopReason: "budget_exhausted", rounds: this.maxRounds, evidence };
  }
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

export interface GitWorktreePlan {
  readonly taskId: string;
  readonly repository: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly createArgs: readonly string[];
  readonly inspectArgs: readonly string[];
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
