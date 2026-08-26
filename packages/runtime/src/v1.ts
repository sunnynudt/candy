import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, lstatSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { cleanChildEnvironment, containsCredentialMaterial } from "@candy/platform";

const MAX_WORKSPACE_PATCH_BYTES = 1_048_576;
export const MAX_UNTRACKED_FILE_BYTES = 1_048_576;
const NO_FOLLOW_FINAL_PATH = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
const O_DIRECTORY_PATH_FLAG = process.platform === "win32" ? 0 : fsConstants.O_DIRECTORY;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TASK_ATTACHMENT_COUNT = 32;
export const MAX_TASK_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_CLEANUP_ENTRIES = 4_096;
export const MAX_ATTACHMENT_METADATA_BYTES = 64 * 1024;
export const MAX_NON_GIT_SNAPSHOT_DEPTH = 64;
export const MAX_NON_GIT_SNAPSHOT_ENTRIES = 20_000;
export const MAX_NON_GIT_SNAPSHOT_FILES = 10_000;
export const MAX_NON_GIT_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const NON_GIT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "out",
  "build",
]);

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

export interface ImageAttachmentPayload {
  readonly id: string;
  readonly mimeType: string;
  readonly data: string;
}

export type AttachmentContentGuard = (content: Uint8Array) => boolean;

export class AttachmentStore {
  public constructor(
    private readonly root: string,
    private readonly clock: () => number = Date.now,
    private readonly contentGuard?: AttachmentContentGuard,
  ) {}

  public async put(
    kind: "image" | "video",
    mimeType: string,
    content: Uint8Array,
  ): Promise<AttachmentMetadata> {
    if (kind === "video")
      throw new Error("Video attachments are unavailable until their provider gate passes.");
    if (!IMAGE_MIME_TYPES.has(mimeType)) throw new Error("Unsupported image MIME type.");
    if (content.byteLength > MAX_ATTACHMENT_BYTES)
      throw new Error(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit.`);
    if (
      containsCredentialMaterial(Buffer.from(content).toString("latin1")) ||
      this.contentGuard?.(content) === true
    )
      throw new Error("Attachment content contains credential material.");
    if (!isValidImageContent(mimeType, content)) throw new Error("Image content is corrupt.");
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
    const metadataPath = path.join(this.root, `${id}.json`);
    try {
      await writeExclusiveFile(metadataPath, JSON.stringify(metadata));
      return metadata;
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = await readAttachmentMetadata(metadataPath);
      if (
        existing.id !== metadata.id ||
        existing.kind !== metadata.kind ||
        existing.mimeType !== metadata.mimeType ||
        existing.bytes !== metadata.bytes ||
        existing.sha256 !== metadata.sha256
      )
        throw new Error("Attachment integrity check failed.", { cause: error });
      return existing;
    }
  }

  public async get(
    id: string,
  ): Promise<{ readonly metadata: AttachmentMetadata; readonly content: Uint8Array }> {
    if (!/^att_[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid attachment id.");
    const metadata = await readAttachmentMetadata(path.join(this.root, `${id}.json`));
    if (
      !Number.isSafeInteger(metadata.bytes) ||
      metadata.bytes < 0 ||
      metadata.bytes > MAX_ATTACHMENT_BYTES
    )
      throw new Error("Attachment integrity check failed.");
    const content = await readBoundedFile(path.join(this.root, `${id}.bin`), MAX_ATTACHMENT_BYTES);
    if (
      metadata.id !== id ||
      metadata.kind !== "image" ||
      !IMAGE_MIME_TYPES.has(metadata.mimeType) ||
      metadata.bytes !== content.byteLength ||
      content.byteLength > MAX_ATTACHMENT_BYTES ||
      !isValidImageContent(metadata.mimeType, content) ||
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
    if (
      containsCredentialMaterial(Buffer.from(attachment.content).toString("latin1")) ||
      this.contentGuard?.(attachment.content) === true
    )
      throw new Error("Attachment content contains credential material.");
    return {
      id,
      mimeType: attachment.metadata.mimeType,
      data: Buffer.from(attachment.content).toString("base64"),
    };
  }

  public async cleanupBefore(cutoff: number): Promise<number> {
    let removed = 0;
    const directory = await opendir(this.root).catch(() => undefined);
    if (directory === undefined) return 0;
    let entries = 0;
    try {
      for await (const entry of directory) {
        entries += 1;
        if (entries > MAX_ATTACHMENT_CLEANUP_ENTRIES)
          throw new Error("Attachment cleanup exceeded its entry limit.");
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const metadataPath = path.join(this.root, entry.name);
        const metadataStat = await stat(metadataPath);
        if (metadataStat.size > MAX_ATTACHMENT_METADATA_BYTES)
          throw new Error("Attachment metadata exceeds its size limit.");
        const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as AttachmentMetadata;
        if (!/^att_[a-f0-9]{64}$/u.test(metadata.id)) continue;
        if (metadata.createdAt < cutoff) {
          await rm(path.join(this.root, `${metadata.id}.json`), { force: true });
          await rm(path.join(this.root, `${metadata.id}.bin`), { force: true });
          removed += 1;
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return removed;
  }
}

async function readBoundedFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW_FINAL_PATH);
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size > maxBytes)
      throw new Error("Attachment exceeds its size limit.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeExclusiveFile(filePath: string, content: string): Promise<void> {
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW_FINAL_PATH,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function readAttachmentMetadata(filePath: string): Promise<AttachmentMetadata> {
  const entry = await lstat(filePath);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error("Attachment metadata is not a regular file.");
  if (entry.size > MAX_ATTACHMENT_METADATA_BYTES)
    throw new Error("Attachment metadata exceeds its size limit.");
  return JSON.parse(
    (await readBoundedFile(filePath, MAX_ATTACHMENT_METADATA_BYTES)).toString("utf8"),
  ) as AttachmentMetadata;
}

function isValidImageContent(mimeType: string, content: Uint8Array): boolean {
  switch (mimeType) {
    case "image/png":
      return isValidPng(content);
    case "image/jpeg":
      return (
        content.byteLength >= 4 &&
        content[0] === 0xff &&
        content[1] === 0xd8 &&
        content.at(-2) === 0xff &&
        content.at(-1) === 0xd9
      );
    case "image/gif":
      return (
        content.byteLength >= 11 &&
        (ascii(content, 0, 6) === "GIF87a" || ascii(content, 0, 6) === "GIF89a") &&
        (content[6] ?? 0) + ((content[7] ?? 0) << 8) !== 0 &&
        (content[8] ?? 0) + ((content[9] ?? 0) << 8) !== 0 &&
        content.at(-1) === 0x3b
      );
    case "image/webp":
      return (
        content.byteLength >= 16 &&
        ascii(content, 0, 4) === "RIFF" &&
        ascii(content, 8, 4) === "WEBP" &&
        readUint32LittleEndian(content, 4) + 8 <= content.byteLength
      );
    default:
      return false;
  }
}

function isValidPng(content: Uint8Array): boolean {
  if (
    content.byteLength < 33 ||
    ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => content[index] === value,
    )
  )
    return false;
  let offset = 8;
  let header = false;
  while (offset + 12 <= content.byteLength) {
    const length = readUint32BigEndian(content, offset);
    const end = offset + 12 + length;
    if (end > content.byteLength) return false;
    const type = ascii(content, offset + 4, 4);
    if (
      readUint32BigEndian(content, offset + 8 + length) !== crc32(content, offset + 4, 4 + length)
    )
      return false;
    if (type === "IHDR") {
      if (
        length !== 13 ||
        readUint32BigEndian(content, offset + 8) === 0 ||
        readUint32BigEndian(content, offset + 12) === 0
      )
        return false;
      header = true;
    }
    if (type === "IEND") return header && length === 0 && end === content.byteLength;
    offset = end;
  }
  return false;
}

function ascii(content: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...content.subarray(offset, offset + length));
}

function readUint32BigEndian(content: Uint8Array, offset: number): number {
  return (
    (((content[offset] ?? 0) << 24) |
      ((content[offset + 1] ?? 0) << 16) |
      ((content[offset + 2] ?? 0) << 8) |
      (content[offset + 3] ?? 0)) >>>
    0
  );
}

function readUint32LittleEndian(content: Uint8Array, offset: number): number {
  return (
    ((content[offset] ?? 0) |
      ((content[offset + 1] ?? 0) << 8) |
      ((content[offset + 2] ?? 0) << 16) |
      ((content[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function crc32(content: Uint8Array, offset: number, length: number): number {
  let crc = 0xffffffff;
  for (const value of content.subarray(offset, offset + length)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface BrowserTabSnapshot {
  readonly tabId: string;
  readonly revision: number;
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly control: "user" | "agent";
  readonly siteAllowed: boolean;
  readonly screenshotAttachmentId?: string;
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

export interface CommandValidatorCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface CommandRunnerRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly workspace: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly activeSecrets?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface CommandRunnerResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly cancelled: boolean;
}

/** Platform-neutral port implemented by the native-process package. */
export interface CommandRunner {
  run(request: CommandRunnerRequest): Promise<CommandRunnerResult>;
}

/** Shared command-validator policy; process startup and cancellation remain platform-owned. */
export class CommandValidator {
  public constructor(private readonly runner: CommandRunner) {}

  public async run(
    command: CommandValidatorCommand,
    workspace: string,
    signal: AbortSignal,
    environment: Readonly<Record<string, string>> = {},
    activeSecrets: readonly string[] = [],
  ): Promise<ValidatorResult> {
    const startedAt = Date.now();
    const result = await this.runner.run({
      executable: command.executable,
      args: command.args,
      cwd: workspace,
      workspace,
      environment,
      activeSecrets,
      signal,
    });
    const evidence = redactValidatorOutput(`${result.stdout}${result.stderr}`, activeSecrets);
    return {
      ok: result.code === 0 && !result.cancelled,
      fingerprint: `${result.code ?? "signal"}:${evidence}`,
      evidence,
      durationMs: Date.now() - startedAt,
    };
  }
}

function redactValidatorOutput(value: string, activeSecrets: readonly string[]): string {
  return activeSecrets.reduce(
    (result, secret) => (secret.length > 0 ? result.split(secret).join("[REDACTED]") : result),
    value.slice(0, 1_048_576),
  );
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
  readonly evidenceSummary?: string;
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
          ...lastEvidenceSummary(evidence),
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
            ...lastEvidenceSummary(evidence),
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
            ...lastEvidenceSummary(evidence),
          });
          return { completed: false, stopReason: "stall_detected", rounds: round, evidence };
        }
        persistProgress(progress, {
          rounds: round,
          evidenceCount: evidence.length,
          completed: false,
          stopReason: "running",
          lastFingerprintHash: fingerprintHash,
          ...lastEvidenceSummary(evidence),
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
          ...lastEvidenceSummary(evidence),
        });
        return { completed: false, stopReason, rounds: round, evidence };
      }
    }
    persistProgress(progress, {
      rounds: this.maxRounds,
      evidenceCount: evidence.length,
      completed: false,
      stopReason: "budget_exhausted",
      ...lastEvidenceSummary(evidence),
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

function lastEvidenceSummary(evidence: readonly ValidatorResult[]): {
  readonly evidenceSummary?: string;
} {
  const summary = evidence.at(-1)?.evidence;
  return summary === undefined ? {} : { evidenceSummary: summary.slice(0, 4_096) };
}

export interface ApplyChangesInput {
  readonly targetIsGit: boolean;
  readonly targetClean: boolean;
  readonly expectedBase: string;
  readonly actualBase: string;
  readonly paths: readonly string[];
  readonly untrackedPaths?: readonly string[];
  readonly patchText: string;
  readonly activeSecrets: readonly string[];
}

/** Platform path operations; the Node `path` module satisfies this shape on any host. */
export interface PathSeam {
  readonly resolve: (...paths: string[]) => string;
  readonly dirname: (value: string) => string;
  readonly relative: (from: string, to: string) => string;
  readonly normalize: (value: string) => string;
  readonly isAbsolute: (value: string) => boolean;
  readonly sep: string;
  /** Optional host canonicalization; omitted by simulated cross-host fixtures. */
  readonly canonicalize?: (value: string) => Promise<string>;
}

const nativeGitPathSeam: PathSeam = {
  resolve: (...paths) => path.resolve(...paths),
  dirname: (value) => path.dirname(value),
  relative: (from, to) => path.relative(from, to),
  normalize: (value) => path.normalize(value),
  isAbsolute: (value) => path.isAbsolute(value),
  sep: path.sep,
  canonicalize: async (value) => {
    try {
      return await realpath(value);
    } catch {
      // Components may not exist yet (for example before `git worktree add`).
      // Resolve the longest existing prefix so the canonical comparison stays
      // consistent with realpath semantics instead of mixing resolved and
      // unresolved aliases such as /var and /private/var.
      let candidate = value;
      const suffix: string[] = [];
      for (;;) {
        const parent = path.dirname(candidate);
        if (parent === candidate) return value;
        suffix.unshift(path.basename(candidate));
        candidate = parent;
        try {
          return path.join(await realpath(candidate), ...suffix);
        } catch {
          // Continue upward until an existing ancestor is found.
        }
      }
    }
  },
};

export class ApplyChangesGuard {
  readonly #path: PathSeam;

  public constructor(
    private readonly targetRoot: string,
    pathSeam: PathSeam = path,
  ) {
    this.#path = pathSeam;
  }

  public check(input: ApplyChangesInput): "allow" | "blocked" {
    if (!input.targetIsGit || !input.targetClean || input.expectedBase !== input.actualBase)
      return "blocked";
    for (const requested of input.paths) {
      if (input.activeSecrets.some((secret) => secret.length > 0 && requested.includes(secret)))
        return "blocked";
      const absolute = this.#path.resolve(this.targetRoot, requested);
      const root = this.#path.resolve(this.targetRoot);
      const relative = this.#path.relative(root, absolute);
      if (
        relative === ".." ||
        relative.startsWith(`..${this.#path.sep}`) ||
        this.#path.isAbsolute(relative)
      )
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

export interface WorkspaceChangeSnapshot {
  readonly available: boolean;
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
  readonly patchText: string;
  readonly patchTruncated: boolean;
}

export interface WorkspaceChangeTracker {
  captureBaseline(workspace: string): Promise<string | undefined>;
  inspect(
    workspace: string,
    baseCommit?: string,
    activeSecrets?: readonly string[],
  ): Promise<WorkspaceChangeSnapshot>;
}

/** Selects the Git or non-Git review implementation without duplicating the policy at clients. */
export class ResolvedWorkspaceChangeTracker implements WorkspaceChangeTracker {
  public constructor(
    private readonly git: WorkspaceChangeTracker,
    private readonly nonGit: WorkspaceChangeTracker,
  ) {}

  public async captureBaseline(workspace: string): Promise<string | undefined> {
    const baseline = await this.git.captureBaseline(workspace);
    if (baseline !== undefined) return baseline;
    await this.nonGit.captureBaseline(workspace);
    return undefined;
  }

  public async inspect(
    workspace: string,
    baseCommit?: string,
    activeSecrets?: readonly string[],
  ): Promise<WorkspaceChangeSnapshot> {
    return baseCommit === undefined
      ? this.nonGit.inspect(workspace, baseCommit, activeSecrets)
      : this.git.inspect(workspace, baseCommit, activeSecrets);
  }
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
      let outputBytes = 0;
      let outputLimitExceeded = false;
      const appendOutput = (current: string, chunk: string): string => {
        outputBytes += Buffer.byteLength(chunk, "utf8");
        if (outputBytes > MAX_WORKSPACE_PATCH_BYTES) {
          outputLimitExceeded = true;
          child.kill();
          return current;
        }
        return current + chunk;
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout = appendOutput(stdout, chunk)));
      child.stderr.on("data", (chunk: string) => (stderr = appendOutput(stderr, chunk)));
      child.once("error", reject);
      child.once("close", (code) => {
        if (outputLimitExceeded) reject(new Error("git output exceeded Candy's size limit."));
        else if (code === 0) resolve(stdout);
        else reject(new Error(`git ${args[0] ?? "command"} failed: ${stderr.trim()}`));
      });
      child.stdin.end(input);
    });
  }
}

/** Resolve Git metadata from Candy's original repository, not from a mutable worktree marker. */
export async function resolveGitCommonDirectory(
  repository: string,
  runner: GitCommandRunner = new NodeGitCommandRunner(),
): Promise<string> {
  const value = (await runner.run(["rev-parse", "--git-common-dir"], repository)).trim();
  if (value.length === 0 || value.includes("\n") || value.includes("\r"))
    throw new Error("Git common directory is invalid.");
  const directory = await realpath(path.resolve(repository, value));
  if (!(await stat(directory)).isDirectory()) throw new Error("Git common directory is invalid.");
  return directory;
}

/** True when a Git working tree has no tracked or untracked changes. */
export async function isGitWorkspaceClean(
  workspace: string,
  runner: GitCommandRunner = new NodeGitCommandRunner(),
): Promise<boolean> {
  try {
    return (await runner.run(["status", "--porcelain=v1", "-z"], workspace)).length === 0;
  } catch {
    return false;
  }
}

/** Reads a task workspace without mutating Git state or exposing command errors. */
export class GitWorkspaceChangeTracker implements WorkspaceChangeTracker {
  readonly #runner: GitCommandRunner;

  public constructor(runner: GitCommandRunner = new NodeGitCommandRunner()) {
    this.#runner = runner;
  }

  public async captureBaseline(workspace: string): Promise<string | undefined> {
    try {
      const baseCommit = (await this.#runner.run(["rev-parse", "HEAD"], workspace)).trim();
      return /^[0-9a-f]{7,64}$/u.test(baseCommit) ? baseCommit : undefined;
    } catch {
      return undefined;
    }
  }

  public async inspect(
    workspace: string,
    baseCommit?: string,
    activeSecrets: readonly string[] = [],
  ): Promise<WorkspaceChangeSnapshot> {
    if (baseCommit === undefined) return emptyWorkspaceChanges();
    try {
      const tracked = splitNull(
        await this.#runner.run(
          ["diff", "--name-only", "--no-ext-diff", "-z", baseCommit, "--"],
          workspace,
        ),
      );
      const untracked = splitNull(
        await this.#runner.run(["ls-files", "--others", "--exclude-standard", "-z"], workspace),
      );
      const patchText = await this.#runner.run(
        ["diff", "--binary", "--no-ext-diff", "--no-color", baseCommit, "--"],
        workspace,
      );
      return {
        available: true,
        tracked: tracked.map(normalizeGitPath),
        untracked: untracked.map(normalizeGitPath),
        patchText: redactWorkspacePatch(patchText, activeSecrets),
        patchTruncated: Buffer.byteLength(patchText, "utf8") >= MAX_WORKSPACE_PATCH_BYTES,
      };
    } catch {
      return emptyWorkspaceChanges();
    }
  }
}

interface NonGitFileState {
  readonly size: number;
  readonly modifiedMs: number;
}

/**
 * Review-only diff for a non-Git workspace. The baseline is a recursive file
 * snapshot (relative path + size + mtime) captured at task creation; inspection
 * compares the current tree and reports added/changed/removed relative paths
 * without mutating anything. Binary-safe sizes are compared, and the patch text
 * stays a review summary because there is no Git patch contract.
 */
export class NonGitWorkspaceChangeTracker implements WorkspaceChangeTracker {
  readonly #baselines = new Map<string, Map<string, NonGitFileState>>();

  public constructor(
    private readonly limits: NonGitWorkspaceSnapshotLimits = {
      maxDepth: MAX_NON_GIT_SNAPSHOT_DEPTH,
      maxEntries: MAX_NON_GIT_SNAPSHOT_ENTRIES,
      maxFiles: MAX_NON_GIT_SNAPSHOT_FILES,
      maxBytes: MAX_NON_GIT_SNAPSHOT_BYTES,
    },
  ) {}

  public async captureBaseline(workspace: string): Promise<string | undefined> {
    this.#baselines.set(workspace, await snapshotNonGitTree(workspace, this.limits));
    return undefined;
  }

  public async inspect(
    workspace: string,
    _baseCommit?: string,
    activeSecrets: readonly string[] = [],
  ): Promise<WorkspaceChangeSnapshot> {
    const baseline = this.#baselines.get(workspace);
    if (baseline === undefined) return emptyWorkspaceChanges();
    const current = await snapshotNonGitTree(workspace, this.limits);
    const changed: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    for (const [relative, state] of current) {
      const before = baseline.get(relative);
      if (before === undefined) added.push(relative);
      else if (before.size !== state.size || before.modifiedMs !== state.modifiedMs)
        changed.push(relative);
    }
    for (const relative of baseline.keys()) {
      if (!current.has(relative)) removed.push(relative);
    }
    const all = [...changed, ...added, ...removed].sort();
    const patchText = redactWorkspacePatch(
      all.map((relative) => `changed: ${relative}`).join("\n"),
      activeSecrets,
    );
    return {
      available: true,
      tracked: all,
      untracked: [],
      patchText,
      patchTruncated: Buffer.byteLength(patchText, "utf8") >= MAX_WORKSPACE_PATCH_BYTES,
    };
  }
}

export interface NonGitWorkspaceSnapshotLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
}

export class NonGitWorkspaceSnapshotLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NonGitWorkspaceSnapshotLimitError";
  }
}

export class NonGitWorkspaceSnapshotRaceError extends Error {
  public constructor(message = "Non-Git workspace changed while it was being snapshotted.") {
    super(message);
    this.name = "NonGitWorkspaceSnapshotRaceError";
  }
}

function sameFileIdentity(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

async function snapshotNonGitFile(
  absolute: string,
  metadata: Awaited<ReturnType<typeof lstat>>,
): Promise<NonGitFileState | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, fsConstants.O_RDONLY | NO_FOLLOW_FINAL_PATH);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ELOOP")) return undefined;
    throw error;
  }
  try {
    const opened = await handle.stat();
    const current = await lstat(absolute).catch(() => undefined);
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !opened.isFile() ||
      !sameFileIdentity(metadata, opened) ||
      !sameFileIdentity(opened, current)
    ) {
      throw new NonGitWorkspaceSnapshotRaceError(
        "Non-Git workspace file changed while it was being snapshotted.",
      );
    }
    return { size: opened.size, modifiedMs: Math.trunc(opened.mtimeMs) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function snapshotNonGitTree(
  root: string,
  limits: NonGitWorkspaceSnapshotLimits,
): Promise<Map<string, NonGitFileState>> {
  const snapshot = new Map<string, NonGitFileState>();
  let entriesSeen = 0;
  let filesSeen = 0;
  let bytesSeen = 0;
  async function visit(directory: string, prefix: string, depth: number): Promise<void> {
    if (depth > limits.maxDepth)
      throw new NonGitWorkspaceSnapshotLimitError(
        "Non-Git workspace snapshot exceeded its depth limit.",
      );
    const directoryMetadata = await lstat(directory).catch(() => undefined);
    if (directoryMetadata === undefined) return;
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) return;
    const handle = await opendir(directory).catch(() => undefined);
    if (handle === undefined) return;
    try {
      for await (const entry of handle) {
        entriesSeen += 1;
        if (entriesSeen > limits.maxEntries)
          throw new NonGitWorkspaceSnapshotLimitError(
            "Non-Git workspace snapshot exceeded its entry limit.",
          );
        const absolute = path.join(directory, entry.name);
        const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (NON_GIT_IGNORED_DIRECTORIES.has(entry.name)) continue;
          const childMetadata = await lstat(absolute).catch(() => undefined);
          if (
            childMetadata === undefined ||
            childMetadata.isSymbolicLink() ||
            !childMetadata.isDirectory()
          )
            continue;
          await visit(absolute, relative, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const metadata = await lstat(absolute).catch(() => undefined);
        if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isFile()) continue;
        const fileState = await snapshotNonGitFile(absolute, metadata);
        if (fileState === undefined) continue;
        filesSeen += 1;
        if (filesSeen > limits.maxFiles)
          throw new NonGitWorkspaceSnapshotLimitError(
            "Non-Git workspace snapshot exceeded its file limit.",
          );
        bytesSeen += fileState.size;
        if (bytesSeen > limits.maxBytes)
          throw new NonGitWorkspaceSnapshotLimitError(
            "Non-Git workspace snapshot exceeded its byte limit.",
          );
        snapshot.set(relative, fileState);
      }
      const finalDirectoryMetadata = await lstat(directory).catch(() => undefined);
      if (
        finalDirectoryMetadata === undefined ||
        finalDirectoryMetadata.isSymbolicLink() ||
        !finalDirectoryMetadata.isDirectory() ||
        !sameFileIdentity(directoryMetadata, finalDirectoryMetadata)
      ) {
        throw new NonGitWorkspaceSnapshotRaceError();
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  await visit(root, "", 0);
  return snapshot;
}

interface WorktreePathBinding {
  readonly absolute: string;
  readonly identity: Awaited<ReturnType<typeof lstat>>;
}

/**
 * Bind every existing component from the Candy worktree root down to `target`
 * with a no-follow directory handle and compare the opened handle identity to
 * the path identity. A same-path directory replacement (different inode) or a
 * symlink swap fails closed instead of relying only on canonical strings.
 */
async function bindWorktreePathComponents(
  root: string,
  target: string,
): Promise<readonly WorktreePathBinding[]> {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Task worktree is outside Candy's worktree root.");
  const bindings: WorktreePathBinding[] = [];
  const rootMetadata = await lstat(absoluteRoot).catch(() => undefined);
  if (rootMetadata === undefined || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Task worktree root is not a real directory.");
  }
  const rootHandle = await open(
    absoluteRoot,
    fsConstants.O_RDONLY | NO_FOLLOW_FINAL_PATH | O_DIRECTORY_PATH_FLAG,
  );
  try {
    const opened = await rootHandle.stat();
    if (!opened.isDirectory() || !sameFileIdentity(rootMetadata, opened)) {
      throw new Error("Task worktree root changed while it was being bound.");
    }
  } finally {
    await rootHandle.close().catch(() => undefined);
  }
  bindings.push({ absolute: absoluteRoot, identity: rootMetadata });
  let current = absoluteRoot;
  const segments = relative === "" ? [] : relative.split(path.sep);
  for (const segment of segments) {
    current = path.join(current, segment);
    const metadata = await lstat(current).catch(() => undefined);
    if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Task worktree path component is not a real directory.");
    }
    const handle = await open(
      current,
      fsConstants.O_RDONLY | NO_FOLLOW_FINAL_PATH | O_DIRECTORY_PATH_FLAG,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory() || !sameFileIdentity(metadata, opened)) {
        throw new Error("Task worktree path component changed while it was being bound.");
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    bindings.push({ absolute: current, identity: metadata });
  }
  return bindings;
}

async function assertWorktreePathComponentsUnchanged(
  bindings: readonly WorktreePathBinding[],
): Promise<void> {
  for (const binding of bindings) {
    const current = await lstat(binding.absolute).catch(() => undefined);
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameFileIdentity(binding.identity, current)
    ) {
      throw new Error("Task worktree path changed while the operation was in progress.");
    }
  }
}

export class GitWorktreeManager {
  readonly #runner: GitCommandRunner;
  readonly #path: PathSeam;

  public constructor(
    private readonly worktreeRoot: string,
    runner: GitCommandRunner = new NodeGitCommandRunner(),
    pathSeam: PathSeam = nativeGitPathSeam,
  ) {
    this.#runner = runner;
    this.#path = pathSeam;
  }

  public async create(plan: GitWorktreePlan): Promise<void> {
    const root = this.rootFor(plan);
    await this.assertWorktreePath(plan.worktreePath, root);
    await mkdir(this.#path.dirname(this.#path.resolve(plan.worktreePath)), { recursive: true });
    await this.assertWorktreePath(plan.worktreePath, root, false);
    const parentBindings = await this.bindWorktreeChain(
      root,
      this.#path.dirname(this.#path.resolve(plan.worktreePath)),
    );
    await this.#runner.run(plan.createArgs, plan.repository);
    await this.assertWorktreeChainUnchanged(parentBindings);
    await this.assertWorktreePath(plan.worktreePath, root);
    const worktreeBindings = await this.bindWorktreeChain(root, plan.worktreePath);
    await this.inspect(plan);
    await this.assertWorktreeChainUnchanged([...parentBindings, ...worktreeBindings]);
  }

  public async inspect(plan: GitWorktreePlan): Promise<string> {
    const root = this.rootFor(plan);
    await this.assertWorktreePath(plan.worktreePath, root);
    const bindings = await this.bindWorktreeChain(root, plan.worktreePath);
    const listing = await this.#runner.run(plan.inspectArgs, plan.repository);
    await this.assertWorktreeChainUnchanged(bindings);
    await this.assertWorktreePath(plan.worktreePath, root);
    const expectedPath = await canonicalGitWorktreePath(plan.worktreePath, this.#path);
    let associated = false;
    for (const entry of parseGitWorktreePorcelain(listing)) {
      if (entry.lockReason !== `candy:${plan.taskId}`) continue;
      if ((await canonicalGitWorktreePath(entry.path, this.#path)) === expectedPath) {
        associated = true;
        break;
      }
    }
    if (!associated) throw new Error("Git worktree association could not be verified.");
    return listing;
  }

  public async unlock(plan: GitWorktreePlan): Promise<void> {
    const root = this.rootFor(plan);
    await this.assertWorktreePath(plan.worktreePath, root);
    const bindings = await this.bindWorktreeChain(root, plan.worktreePath);
    await this.#runner.run(plan.unlockArgs, plan.repository);
    await this.assertWorktreeChainUnchanged(bindings);
  }

  public async removeClean(plan: GitWorktreePlan): Promise<void> {
    const root = this.rootFor(plan);
    await this.assertWorktreePath(plan.worktreePath, root);
    const bindings = await this.bindWorktreeChain(root, plan.worktreePath);
    const status = await this.#runner.run(["status", "--porcelain=v1", "-z"], plan.worktreePath);
    await this.assertWorktreeChainUnchanged(bindings);
    await this.assertWorktreePath(plan.worktreePath, root);
    if (status.length > 0) throw new Error("Dirty worktrees cannot be removed automatically.");
    await this.assertWorktreeChainUnchanged(bindings);
    const parentBindings = await this.bindWorktreeChain(
      root,
      this.#path.dirname(this.#path.resolve(plan.worktreePath)),
    );
    await this.#runner.run(plan.removeArgs, plan.repository);
    await this.assertWorktreeChainUnchanged(parentBindings);
  }

  /** Explicitly discard a task-owned worktree after review, then remove it. */
  public async discard(plan: GitWorktreePlan): Promise<void> {
    const root = this.rootFor(plan);
    await this.inspect(plan);
    await this.assertWorktreePath(plan.worktreePath, root);
    const bindings = await this.bindWorktreeChain(root, plan.worktreePath);
    await this.#runner.run(["reset", "--hard", plan.baseCommit], plan.worktreePath);
    await this.assertWorktreeChainUnchanged(bindings);
    await this.assertWorktreePath(plan.worktreePath, root);
    await this.#runner.run(["clean", "-fd"], plan.worktreePath);
    await this.assertWorktreeChainUnchanged(bindings);
    await this.assertWorktreePath(plan.worktreePath, root);
    await this.unlock(plan);
    const parentBindings = await this.bindWorktreeChain(
      root,
      this.#path.dirname(this.#path.resolve(plan.worktreePath)),
    );
    await this.#runner.run(plan.removeArgs, plan.repository);
    await this.assertWorktreeChainUnchanged(parentBindings);
  }

  public async changes(
    plan: GitWorktreePlan,
  ): Promise<GitChangeManifest & { readonly patchText: string }> {
    const root = this.rootFor(plan);
    await this.assertWorktreePath(plan.worktreePath, root);
    const bindings = await this.bindWorktreeChain(root, plan.worktreePath);
    const tracked = splitNull(
      await this.#runner.run(
        ["diff", "--name-only", "--no-ext-diff", "-z", plan.baseCommit, "--"],
        plan.worktreePath,
      ),
    );
    await this.assertWorktreeChainUnchanged(bindings);
    await this.assertWorktreePath(plan.worktreePath, root);
    const untracked = splitNull(
      await this.#runner.run(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        plan.worktreePath,
      ),
    );
    await this.assertWorktreeChainUnchanged(bindings);
    await this.assertWorktreePath(plan.worktreePath, root);
    const patchText = await this.#runner.run(
      ["diff", "--binary", "--no-ext-diff", "--no-color", plan.baseCommit, "--"],
      plan.worktreePath,
    );
    await this.assertWorktreeChainUnchanged(bindings);
    return { tracked, untracked, patchText };
  }

  private rootFor(plan: GitWorktreePlan): string {
    return plan.worktreeRoot ?? this.worktreeRoot;
  }

  private async bindWorktreeChain(
    root: string,
    target: string,
  ): Promise<readonly WorktreePathBinding[]> {
    // Descriptor-relative binding applies on the real host only. Cross-host
    // fixtures (for example path.win32 seams on macOS) keep the canonical
    // containment checks, which those fixtures already exercise.
    if (this.#path.sep !== path.sep) return [];
    return bindWorktreePathComponents(root, target);
  }

  private async assertWorktreeChainUnchanged(
    bindings: readonly WorktreePathBinding[],
  ): Promise<void> {
    if (bindings.length === 0) return;
    await assertWorktreePathComponentsUnchanged(bindings);
  }

  private async assertWorktreePath(
    worktreePath: string,
    root: string,
    checkCandidate = true,
  ): Promise<void> {
    const resolvedRoot = this.#path.resolve(root);
    const candidate = this.#path.resolve(worktreePath);
    const relative = this.#path.relative(resolvedRoot, candidate);
    if (
      relative === ".." ||
      relative.startsWith(`..${this.#path.sep}`) ||
      this.#path.isAbsolute(relative)
    )
      throw new Error("Task worktree is outside Candy's worktree root.");
    if (this.#path.canonicalize === undefined) return;
    const canonicalRoot = this.#path.normalize(await this.#path.canonicalize(resolvedRoot));
    const canonicalParent = this.#path.normalize(
      await this.#path.canonicalize(this.#path.dirname(candidate)),
    );
    const canonicalCandidate = this.#path.normalize(await this.#path.canonicalize(candidate));
    for (const checked of checkCandidate
      ? [canonicalParent, canonicalCandidate]
      : [canonicalParent]) {
      const canonicalRelative = this.#path.relative(canonicalRoot, checked);
      if (
        canonicalRelative === ".." ||
        canonicalRelative.startsWith(`..${this.#path.sep}`) ||
        this.#path.isAbsolute(canonicalRelative)
      )
        throw new Error("Task worktree canonical path escaped Candy's worktree root.");
    }
  }
}

export class ApplyChangesBlockedError extends Error {
  public constructor(message = "Apply Changes was blocked by a preflight check.") {
    super(message);
    this.name = "ApplyChangesBlockedError";
  }
}

export interface WorkspaceFileSnapshot {
  /** Workspace-relative path (forward slashes). */
  readonly path: string;
  readonly content: Buffer;
}

const MAX_SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * Capture the current content of changed workspace files for `/undo`.
 * Reads use no-follow handles and apply-style containment; credential-bearing
 * and oversized files are skipped (never moved into Candy-owned storage).
 */
export async function captureWorkspaceFileSnapshots(
  workspace: string,
  paths: readonly string[],
  activeSecrets: readonly string[] = [],
): Promise<readonly WorkspaceFileSnapshot[]> {
  const root = path.resolve(workspace);
  const binding = await bindApplyRoot(root);
  const result: WorkspaceFileSnapshot[] = [];
  let totalBytes = 0;
  for (const requested of uniqueRelativePaths(paths)) {
    if (totalBytes >= MAX_SNAPSHOT_TOTAL_BYTES) break;
    try {
      await assertSafePath(root, requested, true, binding);
      const content = await readApplyFile(root, requested, binding);
      if (
        activeSecrets.some((secret) => secret.length > 0 && content.includes(Buffer.from(secret)))
      )
        continue;
      if (content.byteLength > MAX_SNAPSHOT_TOTAL_BYTES - totalBytes) continue;
      totalBytes += content.byteLength;
      result.push({ path: requested, content });
    } catch {
      // Missing, oversized, or racing files are skipped; undo simply has no
      // snapshot for them and stays fail-closed.
    }
  }
  return result;
}

/**
 * Restore previously captured file snapshots into a workspace. The write
 * path uses the same root binding, containment, and no-follow checks as
 * Apply Changes; credential-bearing snapshots are never restored.
 */
export async function restoreWorkspaceFileSnapshots(
  workspace: string,
  snapshots: readonly WorkspaceFileSnapshot[],
  activeSecrets: readonly string[] = [],
): Promise<number> {
  const root = path.resolve(workspace);
  const binding = await bindApplyRoot(root);
  let restored = 0;
  for (const snapshot of snapshots) {
    if (
      activeSecrets.some(
        (secret) => secret.length > 0 && snapshot.content.includes(Buffer.from(secret)),
      )
    )
      continue;
    await ensureSafeDirectory(root, path.dirname(path.resolve(root, snapshot.path)), binding);
    await writeRestoredFile(root, snapshot.path, snapshot.content, binding);
    restored += 1;
  }
  return restored;
}

async function writeRestoredFile(
  root: string,
  requested: string,
  content: Buffer,
  binding: ApplyRootBinding,
): Promise<void> {
  await assertSafePath(root, requested, true, binding);
  const absolute = path.resolve(root, requested);
  const handle = await open(
    absolute,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | NO_FOLLOW_FINAL_PATH,
    0o666,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile())
      throw new ApplyChangesBlockedError("Undo restore requires a regular file.");
    await assertOpenedApplyFile(binding, absolute, opened);
    await handle.truncate(0);
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

interface ApplyRootBinding {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly metadata: Awaited<ReturnType<typeof lstat>>;
}

async function bindApplyRoot(root: string): Promise<ApplyRootBinding> {
  const absolutePath = path.resolve(root);
  const metadata = await lstat(absolutePath).catch(() => {
    throw new ApplyChangesBlockedError("Apply Changes workspace root is unavailable.");
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new ApplyChangesBlockedError("Apply Changes workspace root must be a real directory.");
  const canonicalPath = await realpath(absolutePath).catch(() => {
    throw new ApplyChangesBlockedError("Apply Changes workspace root cannot be canonicalized.");
  });
  return { absolutePath, canonicalPath, metadata };
}

async function assertApplyRootBinding(binding: ApplyRootBinding): Promise<void> {
  const current = await lstat(binding.absolutePath).catch(() => undefined);
  if (
    current === undefined ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameFileIdentity(binding.metadata, current)
  ) {
    throw new ApplyChangesBlockedError(
      "Apply Changes workspace changed while the operation was in progress.",
    );
  }
  const canonical = await realpath(binding.absolutePath).catch(() => undefined);
  if (canonical !== binding.canonicalPath) {
    throw new ApplyChangesBlockedError(
      "Apply Changes workspace changed while the operation was in progress.",
    );
  }
}

async function assertApplyContainedPath(
  binding: ApplyRootBinding,
  candidate: string,
): Promise<void> {
  await assertApplyRootBinding(binding);
  const canonicalCandidate = await realpath(candidate).catch(() => undefined);
  if (canonicalCandidate === undefined) {
    throw new ApplyChangesBlockedError("Apply Changes path disappeared during the operation.");
  }
  const relative = path.relative(binding.canonicalPath, canonicalCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ApplyChangesBlockedError("Apply Changes path escaped its workspace.");
  }
}

async function assertOpenedApplyFile(
  binding: ApplyRootBinding,
  absolute: string,
  opened: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): Promise<void> {
  await assertApplyRootBinding(binding);
  const current = await lstat(absolute).catch(() => undefined);
  if (
    current === undefined ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameFileIdentity(opened, current) ||
    current.size !== opened.size ||
    current.mtimeMs !== opened.mtimeMs
  ) {
    throw new ApplyChangesBlockedError("Apply Changes file changed while it was opened.");
  }
  await assertApplyContainedPath(binding, absolute);
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
    const source = path.resolve(sourceRoot);
    const sameRoot = source === targetRoot;
    const targetBinding = await bindApplyRoot(targetRoot);
    const sourceBinding = sameRoot ? targetBinding : await bindApplyRoot(source);
    let actualBase: string;
    let targetStatus: string;
    try {
      await assertApplyRootBinding(targetBinding);
      actualBase = (await this.#runner.run(["rev-parse", "HEAD"], targetRoot)).trim();
      await assertApplyRootBinding(targetBinding);
      targetStatus = await this.#runner.run(["status", "--porcelain=v1", "-z"], targetRoot);
      await assertApplyRootBinding(targetBinding);
    } catch {
      throw new ApplyChangesBlockedError("Apply Changes requires a valid Git target.");
    }
    const effective = {
      ...input,
      targetIsGit: true,
      targetClean: sameRoot || targetStatus.length === 0,
      actualBase,
    };
    if (this.#guard.check(effective) === "blocked") throw new ApplyChangesBlockedError();

    const paths = uniqueRelativePaths(input.paths);
    for (const requested of paths) {
      await assertSafePath(source, requested, true, sourceBinding);
      await assertSafePath(targetRoot, requested, false, targetBinding);
    }
    const explicitUntrackedPaths = input.untrackedPaths !== undefined;
    const untrackedPaths = explicitUntrackedPaths ? uniqueRelativePaths(input.untrackedPaths!) : [];
    const untrackedContents = new Map<string, Buffer>();
    const reviewedUntrackedCandidates = explicitUntrackedPaths
      ? untrackedPaths
      : uniqueRelativePaths(input.paths);
    for (const requested of reviewedUntrackedCandidates) {
      await assertApplyRootBinding(sourceBinding);
      const isUntracked = Boolean(
        (
          await this.#runner.run(
            ["ls-files", "--others", "--exclude-standard", "--", requested],
            source,
          )
        ).trim(),
      );
      await assertApplyRootBinding(sourceBinding);
      if (!isUntracked) {
        if (explicitUntrackedPaths)
          throw new ApplyChangesBlockedError("Reviewed untracked manifest changed before Apply.");
        continue;
      }
      if (!explicitUntrackedPaths) untrackedPaths.push(requested);
      await assertSafePath(source, requested, true, sourceBinding);
      const content = await readApplyFile(source, requested, sourceBinding);
      if (
        input.activeSecrets.some(
          (secret) => secret.length > 0 && content.includes(Buffer.from(secret)),
        )
      ) {
        throw new ApplyChangesBlockedError(
          "Reviewed untracked content contains an active provider credential.",
        );
      }
      untrackedContents.set(requested, content);
      if (sameRoot) continue;
      await assertApplyRootBinding(targetBinding);
      try {
        await lstat(path.resolve(targetRoot, requested));
        throw new ApplyChangesBlockedError(
          "Target already contains an untracked Apply Changes path.",
        );
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
      await assertApplyRootBinding(targetBinding);
    }
    if (input.patchText.length > 0) {
      if (sameRoot) {
        try {
          await assertApplyRootBinding(sourceBinding);
          const currentPatch = await this.#runner.run(
            ["diff", "--binary", "--no-ext-diff", "--no-color", input.expectedBase, "--"],
            source,
          );
          await assertApplyRootBinding(sourceBinding);
          if (currentPatch !== input.patchText) {
            throw new ApplyChangesBlockedError("Reviewed diff changed before Apply.");
          }
        } catch (error) {
          if (error instanceof ApplyChangesBlockedError) throw error;
          throw new ApplyChangesBlockedError(
            `Git refused the reviewed patch: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      } else {
        try {
          await assertApplyRootBinding(targetBinding);
          await this.#runner.run(
            ["apply", "--check", "--binary", "--whitespace=nowarn", "--"],
            targetRoot,
            input.patchText,
          );
          await assertApplyRootBinding(targetBinding);
          await this.#runner.run(
            ["apply", "--binary", "--whitespace=nowarn", "--"],
            targetRoot,
            input.patchText,
          );
          await assertApplyRootBinding(targetBinding);
        } catch (error) {
          throw new ApplyChangesBlockedError(
            `Git refused the reviewed patch: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }
    }
    for (const requested of untrackedPaths) {
      if (sameRoot) continue;
      const targetPath = path.resolve(targetRoot, requested);
      await ensureSafeDirectory(targetRoot, path.dirname(targetPath), targetBinding);
      await assertSafePath(targetRoot, requested, true, targetBinding);
      const content =
        untrackedContents.get(requested) ?? (await readApplyFile(source, requested, sourceBinding));
      await writeApplyFile(targetRoot, requested, content, targetBinding);
      await assertSafePath(targetRoot, requested, false, targetBinding);
    }
    return "applied";
  }
}

export interface GitWorktreePlan {
  readonly taskId: string;
  readonly repository: string;
  readonly worktreeRoot?: string;
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
  worktreeRoot?: string,
): GitWorktreePlan {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(taskId))
    throw new Error("Task id is not safe for worktree association.");
  if (!/^[0-9a-f]{7,64}$/u.test(baseCommit))
    throw new Error("Worktree base must be a Git commit id.");
  return {
    taskId,
    repository,
    ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
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

/** Candy-owned root for a task worktree: inside the project's `.git` when available. */
export function resolveTaskWorktreeRoot(repository: string, fallbackRoot: string): string {
  const dotGit = path.join(repository, ".git");
  try {
    if (lstatSync(dotGit).isDirectory()) {
      return path.join(dotGit, "candy-worktrees");
    }
  } catch {
    // `.git` may be a file (submodule or linked worktree) or missing; fall back below.
  }
  return fallbackRoot;
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

function emptyWorkspaceChanges(): WorkspaceChangeSnapshot {
  return { available: false, tracked: [], untracked: [], patchText: "", patchTruncated: false };
}

function normalizeGitPath(value: string): string {
  return value.replaceAll("\\", "/");
}

interface GitWorktreePorcelainEntry {
  readonly path: string;
  readonly lockReason?: string;
}

/**
 * Git's porcelain output is NUL-delimited. Parse it instead of matching arbitrary
 * substrings so an unrelated worktree or lock reason cannot satisfy an association check.
 */
function parseGitWorktreePorcelain(listing: string): readonly GitWorktreePorcelainEntry[] {
  const entries: GitWorktreePorcelainEntry[] = [];
  let worktreePath: string | undefined;
  let lockReason: string | undefined;
  const finishEntry = () => {
    if (worktreePath !== undefined) {
      entries.push(
        lockReason === undefined ? { path: worktreePath } : { path: worktreePath, lockReason },
      );
    }
    worktreePath = undefined;
    lockReason = undefined;
  };

  for (const field of listing.split("\0")) {
    if (field.length === 0) {
      finishEntry();
      continue;
    }
    if (field.startsWith("worktree ")) {
      worktreePath = field.slice("worktree ".length);
    } else if (field === "locked") {
      lockReason = "";
    } else if (field.startsWith("locked ")) {
      lockReason = field.slice("locked ".length);
    }
  }
  finishEntry();
  return entries;
}

async function canonicalGitWorktreePath(value: string, pathSeam: PathSeam): Promise<string> {
  const normalized = pathSeam.normalize(pathSeam.resolve(value));
  const canonical = pathSeam.canonicalize
    ? pathSeam.normalize(pathSeam.resolve(await pathSeam.canonicalize(normalized)))
    : normalized;
  return pathSeam.sep === "\\" ? canonical.toLocaleLowerCase() : canonical;
}

function redactWorkspacePatch(value: string, activeSecrets: readonly string[]): string {
  return activeSecrets.reduce(
    (result, secret) => (secret.length > 0 ? result.split(secret).join("[REDACTED]") : result),
    value.slice(0, MAX_WORKSPACE_PATCH_BYTES),
  );
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
  binding?: ApplyRootBinding,
): Promise<void> {
  if (binding !== undefined) await assertApplyRootBinding(binding);
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
  if (binding !== undefined && requireLeaf) await assertApplyRootBinding(binding);
}

async function readApplyFile(
  root: string,
  requested: string,
  binding: ApplyRootBinding,
): Promise<Buffer> {
  await assertSafePath(root, requested, false, binding);
  const absolute = path.resolve(root, requested);
  const handle = await open(absolute, fsConstants.O_RDONLY | NO_FOLLOW_FINAL_PATH);
  try {
    const opened = await handle.stat();
    if (!opened.isFile())
      throw new ApplyChangesBlockedError("Apply Changes requires a regular file.");
    if (opened.size > MAX_UNTRACKED_FILE_BYTES)
      throw new ApplyChangesBlockedError(
        `Untracked file exceeds the ${MAX_UNTRACKED_FILE_BYTES}-byte Apply limit.`,
      );
    await assertOpenedApplyFile(binding, absolute, opened);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function ensureSafeDirectory(
  root: string,
  directory: string,
  binding: ApplyRootBinding,
): Promise<void> {
  await assertApplyRootBinding(binding);
  const absoluteRoot = path.resolve(root);
  const absoluteDirectory = path.resolve(directory);
  const relative = path.relative(absoluteRoot, absoluteDirectory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new ApplyChangesBlockedError("Apply Changes directory escaped its target workspace.");
  let current = absoluteRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      const existing = await lstat(current);
      if (existing.isSymbolicLink() || !existing.isDirectory())
        throw new ApplyChangesBlockedError("Symlinked Apply Changes directories are blocked.");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      await mkdir(current);
    }
    const checked = await lstat(current);
    if (checked.isSymbolicLink() || !checked.isDirectory())
      throw new ApplyChangesBlockedError("Apply Changes directory changed while it was created.");
    await assertApplyContainedPath(binding, current);
  }
}

async function writeApplyFile(
  root: string,
  requested: string,
  content: Buffer,
  binding: ApplyRootBinding,
): Promise<void> {
  await assertSafePath(root, requested, true, binding);
  const absolute = path.resolve(root, requested);
  const handle = await open(
    absolute,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW_FINAL_PATH,
    0o666,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile())
      throw new ApplyChangesBlockedError("Apply Changes requires a regular file.");
    await assertOpenedApplyFile(binding, absolute, opened);
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}
