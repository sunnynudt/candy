import type { CandyModelId, CredentialName, CredentialPresence } from "@candy/platform";
import type { TaskProgress, ValidatorSpec } from "@candy/protocol";

export interface RendererTaskProjection {
  readonly taskId: string;
  readonly state:
    | "idle"
    | "queued"
    | "running"
    | "waiting_approval"
    | "paused"
    | "interrupted"
    | "completed"
    | "cancelled";
  readonly revision: number;
  readonly approvalProfile: "read-only" | "auto";
  readonly model: CandyModelId;
  readonly workspacePath?: string;
  readonly workspaceBaseline?: string;
  readonly workspaceState: "local" | "worktree";
  readonly worktreePath?: string;
  readonly progress?: TaskProgress;
  readonly changedFiles: readonly string[];
  readonly trackedFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly diff: string;
  readonly diffTruncated: boolean;
  readonly transcript: readonly {
    readonly role: "user" | "assistant" | "tool";
    readonly text: string;
  }[];
}

export interface CredentialBridge {
  set(name: CredentialName, value: string): Promise<void>;
  replace(name: CredentialName, value: string): Promise<void>;
  delete(name: CredentialName): Promise<void>;
  has(name: CredentialName): Promise<CredentialPresence>;
}

export interface WorkspaceSelection {
  readonly path: string;
}

export interface WorkspaceBridge {
  choose(): Promise<WorkspaceSelection | undefined>;
  current(): Promise<WorkspaceSelection | undefined>;
}

export interface DesktopPreloadApi {
  readonly credentials: CredentialBridge;
  readonly workspace: WorkspaceBridge;
  readonly attachments: {
    pickImage(): Promise<string | undefined>;
  };
  readonly tasks: {
    create(
      prompt: string,
      approvalProfile: "read-only" | "auto",
      model?: CandyModelId,
      attachmentIds?: readonly string[],
      validator?: ValidatorSpec,
    ): Promise<RendererTaskProjection>;
    snapshot(taskId: string): Promise<RendererTaskProjection>;
    send(command: {
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly type: "task.run" | "task.cancel" | "task.pause" | "task.resume";
    }): Promise<void>;
    apply(input: {
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly expectedBase: string;
      readonly tracked: readonly string[];
      readonly untracked: readonly string[];
    }): Promise<RendererTaskProjection>;
    discard(input: {
      readonly taskId: string;
      readonly expectedRevision: number;
    }): Promise<RendererTaskProjection>;
    onUpdate(listener: (projection: RendererTaskProjection) => void): () => void;
  };
}

export type WindowCloseBehavior = "hide-to-tray" | "quit-and-cancel";

export function classifyWindowClose(explicitQuit: boolean): WindowCloseBehavior {
  return explicitQuit ? "quit-and-cancel" : "hide-to-tray";
}

export function redactRendererText(text: string, forbiddenSecrets: readonly string[]): string {
  return forbiddenSecrets.reduce(
    (result, secret) => (secret.length > 0 ? result.split(secret).join("[REDACTED]") : result),
    text,
  );
}

export function createCredentialBridge(store: CredentialBridge): CredentialBridge {
  return {
    set: (name, value) => store.set(name, value),
    replace: (name, value) => store.replace(name, value),
    delete: (name) => store.delete(name),
    has: (name) => store.has(name),
  };
}

export function assertCredentialName(name: string): asserts name is "deepseek" | "minimax-cn" {
  if (name !== "deepseek" && name !== "minimax-cn") throw new Error("Unsupported credential name.");
}

export function assertTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(taskId)) throw new Error("Invalid task id.");
}

export function assertWorkspacePath(workspacePath: string): void {
  if (
    workspacePath.length === 0 ||
    workspacePath.includes("\0") ||
    workspacePath.includes("\r") ||
    workspacePath.includes("\n") ||
    !isAbsoluteWorkspacePath(workspacePath)
  )
    throw new Error("Workspace path must be absolute.");
}

export function isAbsoluteWorkspacePath(workspacePath: string): boolean {
  return (
    workspacePath.startsWith("/") ||
    workspacePath.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/u.test(workspacePath)
  );
}

export function assertValidatorSpec(value: unknown): asserts value is ValidatorSpec {
  if (typeof value !== "object" || value === null) throw new Error("Invalid validator.");
  const executable = (value as { readonly executable?: unknown }).executable;
  const args = (value as { readonly args?: unknown }).args;
  if (typeof executable !== "string") throw new Error("Validator executable is invalid.");
  assertWorkspacePath(executable);
  if (
    !Array.isArray(args) ||
    args.some(
      (arg) =>
        typeof arg !== "string" ||
        arg.includes("\0") ||
        /(?:Bearer\s+|sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._~+/=-]{16,}/u.test(arg),
    )
  )
    throw new Error("Validator arguments are invalid.");
}

export function assertApplyPaths(value: unknown): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.includes("\0") ||
        entry.includes("\\") ||
        entry === "." ||
        entry.startsWith("/") ||
        entry.startsWith("../") ||
        entry.includes("/../") ||
        entry.endsWith("/.."),
    )
  )
    throw new Error("Apply paths must be relative.");
}
