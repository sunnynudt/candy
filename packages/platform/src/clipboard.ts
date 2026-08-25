import { spawn } from "node:child_process";

/**
 * Platform clipboard adapter for the Candy TUI.
 *
 * The TUI copies already-redacted transcript text (active provider secrets
 * and control characters are removed before text ever reaches the
 * transcript), so the clipboard never carries credential material from this
 * path. The helper itself fails closed on unsupported platforms and on any
 * non-zero helper exit.
 */

export class ClipboardUnavailableError extends Error {}

export interface ClipboardCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Resolve the platform clipboard helper command. Returns undefined on
 * platforms without an accepted helper (fail-closed).
 */
export function resolveClipboardCommand(
  platform: NodeJS.Platform = process.platform,
): ClipboardCommand | undefined {
  if (platform === "darwin") {
    return { command: "/usr/bin/pbcopy", args: [] };
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ],
    };
  }
  return undefined;
}

export interface CopyToClipboardOptions {
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
  /** Test seam; the production default resolves the platform helper. */
  readonly resolveCommand?: (platform: NodeJS.Platform) => ClipboardCommand | undefined;
}

/** Copy text to the system clipboard through the platform helper command. */
export function copyToClipboard(
  value: string,
  options: CopyToClipboardOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const resolveCommand = options.resolveCommand ?? resolveClipboardCommand;
  const resolved = resolveCommand(platform);
  if (resolved === undefined) {
    return Promise.reject(
      new ClipboardUnavailableError(`Clipboard is unavailable on ${platform}.`),
    );
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(resolved.command, [...resolved.args], {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string): void => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new ClipboardUnavailableError("Clipboard helper timed out."));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new ClipboardUnavailableError(`Clipboard helper failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new ClipboardUnavailableError(
          `Clipboard helper failed (exit ${code}): ${stderr.trim().slice(0, 200)}`,
        ),
      );
    });
    try {
      child.stdin.end(value);
    } catch (error) {
      clearTimeout(timeout);
      reject(
        new ClipboardUnavailableError(
          `Clipboard helper input rejected: ${(error as Error).message}`,
        ),
      );
    }
  });
}
