import { spawn } from "node:child_process";

/**
 * External editor launching for the Candy TUI (Ctrl+G).
 *
 * The editor is a user-invoked interactive process that takes over the
 * terminal while the TUI is suspended, so it inherits the full process
 * environment (VISUAL/EDITOR, shell config, editor plugins) unlike Candy's
 * isolated tool subprocesses. The edited text lives in a Candy-owned
 * application-data temp file that is deleted after the editor exits.
 */

export interface ExternalEditorCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export class ExternalEditorUnavailableError extends Error {}

/**
 * Resolve the editor command: $VISUAL, then $EDITOR, then the platform
 * default (nano on POSIX hosts, notepad.exe on Windows). A configured value
 * is split on whitespace so values like "code -w" resolve to a command plus
 * fixed arguments; quoted arguments are not supported.
 */
export function resolveExternalEditorCommand(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ExternalEditorCommand {
  const configured = environment.VISUAL ?? environment.EDITOR;
  if (configured !== undefined && configured.trim().length > 0) {
    const parts = configured.trim().split(/\s+/);
    const command = parts[0];
    if (command !== undefined) return { command, args: parts.slice(1) };
  }
  if (platform === "win32") return { command: "notepad.exe", args: [] };
  return { command: "nano", args: [] };
}

/**
 * Normalize editor output for the input line: normalize CRLF to LF, and
 * strip the trailing newline that editors add when the original input did
 * not end with one.
 */
export function normalizeEditorOutput(original: string, updated: string): string {
  const normalized = updated.replace(/\r\n/g, "\n");
  if (!original.endsWith("\n") && normalized.endsWith("\n")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

export interface LaunchExternalEditorOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly resolveCommand?: (
    environment: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ) => ExternalEditorCommand;
}

/**
 * Launch the editor on the target file with an inherited terminal and
 * resolve with its exit code. There is deliberately no timeout: the editor
 * session lasts as long as the user keeps it open.
 */
export function launchExternalEditor(
  target: string,
  options: LaunchExternalEditorOptions = {},
): Promise<number> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const resolveCommand = options.resolveCommand ?? resolveExternalEditorCommand;
  const resolved = resolveCommand(environment, platform);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(resolved.command, [...resolved.args, target], {
      stdio: "inherit",
    });
    child.on("error", (error) => {
      reject(
        new ExternalEditorUnavailableError(
          `External editor ${resolved.command} failed to start: ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}
