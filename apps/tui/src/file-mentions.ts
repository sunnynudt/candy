import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { redactCredentialMaterial } from "@candy/platform";

const MAX_MENTION_FILE_BYTES = 64 * 1024;
const MAX_MENTION_DIRECTORY_FILES = 100;
const MAX_MENTION_DIRECTORY_BYTES = 256 * 1024;
const MAX_MENTION_DIRECTORY_DEPTH = 8;

export interface ExpandedWorkspaceMentionPrompt {
  readonly prompt: string;
  readonly expandedPaths: readonly string[];
  readonly skippedPaths: readonly string[];
}

interface MentionReplacement {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/** Provide bounded @path completion from the selected Local Workspace. */
export function createWorkspaceMentionAutocompleteProvider(
  workspacePath: () => string,
): AutocompleteProvider {
  return {
    async getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    ): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? "";
      const beforeCursor = currentLine.slice(0, cursorCol);
      const prefix = extractMentionPrefix(beforeCursor);
      if (prefix === null || beforeCursor.trimStart().startsWith("/")) return null;
      const items = await listMentionSuggestions(workspacePath(), prefix, options.signal);
      if (options.signal.aborted || items.length === 0) return null;
      return { items, prefix };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = lines[cursorLine] ?? "";
      const start = cursorCol - prefix.length;
      if (start < 0 || currentLine.slice(start, cursorCol) !== prefix) {
        return { lines, cursorLine, cursorCol };
      }
      const nextLines = [...lines];
      nextLines[cursorLine] =
        currentLine.slice(0, start) + item.value + currentLine.slice(cursorCol);
      return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol): boolean {
      const currentLine = lines[cursorLine] ?? "";
      return extractMentionPrefix(currentLine.slice(0, cursorCol)) !== null;
    },
  };
}

/** Expand explicit @file references into bounded, redacted model context. */
export async function expandWorkspaceMentionPrompt(
  prompt: string,
  workspaceRoot: string,
  activeSecrets: readonly string[] = [],
): Promise<ExpandedWorkspaceMentionPrompt> {
  const root = path.resolve(workspaceRoot);
  const canonicalRoot = await realpath(root);
  const replacements: MentionReplacement[] = [];
  const contextBlocks: string[] = [];
  const expandedPaths: string[] = [];
  const skippedPaths: string[] = [];
  const seenPaths = new Set<string>();

  for (const match of prompt.matchAll(/(^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/gu)) {
    const fullMatch = match[0];
    const leading = match[1] ?? "";
    const mentionPath = match[2] ?? match[3] ?? match[4];
    const start = (match.index ?? 0) + leading.length;
    if (mentionPath === undefined || mentionPath.length === 0) continue;
    const relativePath = normalizeMentionPath(mentionPath);
    if (relativePath === undefined) continue;
    const absolutePath = path.resolve(root, relativePath);
    if (!isInside(root, absolutePath)) continue;

    const safeRelativePath = relativeWorkspacePath(root, absolutePath);
    if (seenPaths.has(safeRelativePath)) continue;
    seenPaths.add(safeRelativePath);

    const resolved = await resolveMentionPath(canonicalRoot, absolutePath, activeSecrets);
    if (resolved === undefined) {
      skippedPaths.push(safeRelativePath);
      continue;
    }
    expandedPaths.push(safeRelativePath);
    contextBlocks.push(resolved.block);
    replacements.push({
      start,
      end: start + fullMatch.length - leading.length,
      replacement: `[workspace ${resolved.kind}: ${safeRelativePath}]`,
    });
  }

  const promptWithMarkers = applyReplacements(prompt, replacements);
  if (contextBlocks.length === 0) {
    return { prompt: promptWithMarkers, expandedPaths, skippedPaths };
  }
  return {
    prompt: `${promptWithMarkers}\n\n<workspace-context>\n${contextBlocks.join("\n")}\n</workspace-context>`,
    expandedPaths,
    skippedPaths,
  };
}

function extractMentionPrefix(textBeforeCursor: string): string | null {
  const match = textBeforeCursor.match(/(?:^|\s)(@[^\s]*)$/u);
  return match?.[1] ?? null;
}

async function listMentionSuggestions(
  workspaceRoot: string,
  prefix: string,
  signal: AbortSignal,
): Promise<AutocompleteItem[]> {
  if (signal.aborted) return [];
  const root = path.resolve(workspaceRoot);
  const mentionPath = prefix.slice(1).replaceAll("\\", "/");
  const separator = mentionPath.lastIndexOf("/");
  const parentText = separator < 0 ? "" : mentionPath.slice(0, separator);
  const query = separator < 0 ? mentionPath : mentionPath.slice(separator + 1);
  const normalizedParent = normalizeMentionPath(parentText);
  if (normalizedParent === undefined) return [];
  const parentPath = path.resolve(root, normalizedParent || ".");
  if (!isInside(root, parentPath)) return [];

  let entries;
  try {
    const parentStat = await lstat(parentPath);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return [];
    entries = await readdir(parentPath, { withFileTypes: true });
  } catch {
    return [];
  }
  if (signal.aborted) return [];

  const lowerQuery = query.toLowerCase();
  return entries
    .filter(
      (entry) =>
        !entry.isSymbolicLink() &&
        entry.name !== ".git" &&
        entry.name !== "node_modules" &&
        entry.name.toLowerCase().includes(lowerQuery),
    )
    .sort((left, right) => {
      const directoryOrder = Number(right.isDirectory()) - Number(left.isDirectory());
      return directoryOrder || left.name.localeCompare(right.name);
    })
    .slice(0, 100)
    .map((entry) => {
      const relativePath = `${parentText.length === 0 ? "" : `${parentText}/`}${entry.name}`;
      const value = `@${relativePath}${entry.isDirectory() ? "/" : ""}`;
      return {
        value,
        label: `${entry.name}${entry.isDirectory() ? "/" : ""}`,
        description: relativePath,
      };
    });
}

async function resolveMentionPath(
  canonicalRoot: string,
  absolutePath: string,
  activeSecrets: readonly string[],
): Promise<{ readonly kind: "file" | "directory"; readonly block: string } | undefined> {
  let entry;
  try {
    entry = await lstat(absolutePath);
  } catch {
    return undefined;
  }
  if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) return undefined;

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch {
    return undefined;
  }
  if (!isInside(canonicalRoot, canonicalPath)) return undefined;
  if (entry.isDirectory()) {
    const files: string[] = [];
    await collectMentionFiles(canonicalRoot, canonicalPath, 0, files, new Set<string>());
    const blocks: string[] = [];
    let totalBytes = 0;
    for (const filePath of files) {
      if (blocks.length >= MAX_MENTION_DIRECTORY_FILES) break;
      const content = await readMentionFile(filePath, activeSecrets);
      if (content === undefined) continue;
      const contentBytes = Buffer.byteLength(content, "utf8");
      if (totalBytes + contentBytes > MAX_MENTION_DIRECTORY_BYTES) break;
      totalBytes += contentBytes;
      const relativePath = relativeWorkspacePath(canonicalRoot, filePath);
      blocks.push(`<file path="${escapeAttribute(relativePath)}">\n${content}</file>`);
    }
    if (blocks.length === 0) return undefined;
    const relativePath = relativeWorkspacePath(canonicalRoot, canonicalPath);
    return {
      kind: "directory",
      block: `<directory path="${escapeAttribute(relativePath)}">\n${blocks.join("\n")}\n</directory>`,
    };
  }

  if (entry.size > MAX_MENTION_FILE_BYTES) return undefined;
  const content = await readMentionFile(canonicalPath, activeSecrets);
  if (content === undefined) return undefined;
  const relativePath = relativeWorkspacePath(canonicalRoot, canonicalPath);
  return {
    kind: "file",
    block: `<file path="${escapeAttribute(relativePath)}">\n${content}</file>`,
  };
}

async function readMentionFile(
  absolutePath: string,
  activeSecrets: readonly string[],
): Promise<string | undefined> {
  let entry;
  try {
    entry = await lstat(absolutePath);
  } catch {
    return undefined;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_MENTION_FILE_BYTES) {
    return undefined;
  }

  try {
    const bytes = await readFile(absolutePath);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return redactCredentialMaterial(text, activeSecrets);
  } catch {
    return undefined;
  }
}

async function collectMentionFiles(
  canonicalRoot: string,
  directoryPath: string,
  depth: number,
  files: string[],
  visitedDirectories: Set<string>,
): Promise<void> {
  if (depth > MAX_MENTION_DIRECTORY_DEPTH || files.length >= MAX_MENTION_DIRECTORY_FILES) return;
  const canonicalDirectory = await realpath(directoryPath).catch(() => undefined);
  if (canonicalDirectory === undefined || !isInside(canonicalRoot, canonicalDirectory)) return;
  if (visitedDirectories.has(canonicalDirectory)) return;
  visitedDirectories.add(canonicalDirectory);

  let entries;
  try {
    entries = await readdir(canonicalDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (files.length >= MAX_MENTION_DIRECTORY_FILES) return;
    if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const absolutePath = path.join(canonicalDirectory, entry.name);
    if (entry.isDirectory()) {
      await collectMentionFiles(canonicalRoot, absolutePath, depth + 1, files, visitedDirectories);
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
}

function normalizeMentionPath(value: string): string | undefined {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.split(/[\\/]+/u).some((segment) => segment === "..")
  )
    return undefined;
  return value.replaceAll("/", path.sep);
}

function relativeWorkspacePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/") || ".";
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function applyReplacements(prompt: string, replacements: readonly MentionReplacement[]): string {
  let result = prompt;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    result =
      result.slice(0, replacement.start) + replacement.replacement + result.slice(replacement.end);
  }
  return result;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
