import type { CredentialName, CredentialPresence } from "@candy/platform";

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
  readonly changedFiles: readonly string[];
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

export interface DesktopPreloadApi {
  readonly credentials: CredentialBridge;
  readonly tasks: {
    snapshot(taskId: string): Promise<RendererTaskProjection>;
    send(command: {
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly type: "task.run" | "task.cancel" | "task.pause" | "task.resume";
    }): Promise<void>;
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
