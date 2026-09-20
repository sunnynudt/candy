import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const moduleRequire = createRequire(import.meta.url);
const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;

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

export type ClipboardImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** A raster image deliberately read only after the user invokes paste. */
export interface ClipboardImage {
  readonly mimeType: ClipboardImageMimeType;
  readonly content: Uint8Array;
}

interface NativeImageClipboard {
  hasImage(): boolean;
  getImageBinary(): Promise<Array<number>>;
}

/** Test seam for the native clipboard reader. */
export interface ReadClipboardImageOptions {
  readonly platform?: NodeJS.Platform;
  readonly maxBytes?: number;
  readonly nativeClipboard?: NativeImageClipboard | undefined;
}

function loadNativeImageClipboard(): NativeImageClipboard | undefined {
  try {
    return moduleRequire("@mariozechner/clipboard") as NativeImageClipboard;
  } catch {
    return undefined;
  }
}

/**
 * Read a PNG image from the local system clipboard after an explicit user
 * paste action. Clipboard text is intentionally never read by this API.
 */
export async function readClipboardImage(
  options: ReadClipboardImageOptions = {},
): Promise<ClipboardImage | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32")
    throw new ClipboardUnavailableError(`Image clipboard is unavailable on ${platform}.`);
  const nativeClipboard = options.nativeClipboard ?? loadNativeImageClipboard();
  if (nativeClipboard === undefined)
    throw new ClipboardUnavailableError("Image clipboard helper is unavailable.");
  if (!nativeClipboard.hasImage()) return undefined;
  const content = Uint8Array.from(await nativeClipboard.getImageBinary());
  const maxBytes = options.maxBytes ?? MAX_CLIPBOARD_IMAGE_BYTES;
  if (content.byteLength === 0) return undefined;
  if (content.byteLength > maxBytes)
    throw new ClipboardUnavailableError(`Clipboard image exceeds the ${maxBytes}-byte limit.`);
  return { mimeType: "image/png", content };
}

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
