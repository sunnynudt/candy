import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { redactCredentialMaterial } from "@candy/platform";
import type {
  LoadExtensionsResult,
  PromptTemplate,
  ResourceDiagnostic,
  ResourceLoader,
  Skill,
} from "@earendil-works/pi-coding-agent";

const MAX_CONTEXT_FILE_BYTES = 64 * 1024;
const MAX_CANDY_RESOURCE_BYTES = 64 * 1024;
const MAX_CANDY_RESOURCE_DEPTH = 32;
const MAX_CANDY_RESOURCE_DIRECTORIES = 2_048;
const MAX_CANDY_RESOURCE_FILES = 2_048;
const MAX_CANDY_RESOURCE_DIRECTORY_ENTRIES = 2_048;
const MAX_CANDY_RESOURCE_TOTAL_BYTES = 8 * 1024 * 1024;
/** Model-visible skill budget across all skill roots; higher-priority roots win. */
const MAX_MODEL_SKILLS = 80;

/**
 * Resolve the external skill roots in priority order: the agent-agnostic
 * shared directory `~/.agents/skills` first, then directories listed in
 * `CANDY_SKILL_DIRS` (path-delimiter separated, `~` expanded). Candy-owned
 * `app-data/skills` is added separately by the loader and wins over all of
 * these. External roots are only ever read through the restricted loader;
 * they are never execution roots.
 */
export function resolveCandySkillRoots(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): readonly string[] {
  const roots: string[] = [path.join(homeDirectory, ".agents", "skills")];
  const configured = environment.CANDY_SKILL_DIRS;
  if (configured !== undefined) {
    for (const raw of configured.split(path.delimiter)) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      roots.push(expandHomePath(trimmed, homeDirectory));
    }
  }
  return roots;
}

function expandHomePath(value: string, homeDirectory: string): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
}
const CONTEXT_FILE_NAME = "AGENTS.md";
const DEFAULT_CANDY_SYSTEM_PROMPT =
  "Candy is a local-first coding agent. Keep provider credentials, session content, and diagnostics inside Candy's approved boundaries. Use the selected workspace only and report bounded evidence.";

interface RestrictedResourceFileStats {
  readonly size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface RestrictedResourceFileSystem {
  lstat(filePath: string): RestrictedResourceFileStats;
  readFile(filePath: string): Buffer;
  readFileNoFollow?(filePath: string): Buffer;
  realpath(filePath: string): string;
  readDirectory?(
    directory: string,
    visit: (entry: RestrictedResourceDirectoryEntry) => boolean,
  ): void;
  readdir?(directory: string): readonly RestrictedResourceDirectoryEntry[];
}

interface RestrictedResourceDirectoryEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

const DEFAULT_FILE_SYSTEM: RestrictedResourceFileSystem = {
  lstat: (filePath) => lstatSync(filePath),
  readFile: (filePath) => readFileSync(filePath),
  readFileNoFollow: (filePath) => {
    const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    const descriptor = openSync(filePath, fsConstants.O_RDONLY | noFollow);
    try {
      return readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  },
  realpath: (filePath) => realpathSync(filePath),
  readDirectory: (directory, visit) => {
    const handle = opendirSync(directory);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) break;
        if (!visit(entry)) break;
      }
    } finally {
      try {
        handle.closeSync();
      } catch {
        // The iterator may have already closed the directory.
      }
    }
  },
};

/**
 * Candy's resource boundary. Pi is allowed to consume the public ResourceLoader
 * contract, but it must not discover files, packages, or executable resources.
 */
export class CandyRestrictedResourceLoader implements ResourceLoader {
  private readonly extensionRuntime = createExtensionRuntime();
  private readonly fileSystem: RestrictedResourceFileSystem;
  private readonly activeSecrets: readonly string[];

  private readonly agentsFiles: Array<{ path: string; content: string }>;
  private readonly skills: Skill[];
  private readonly skillDiagnostics: ResourceDiagnostic[];
  private readonly skillReadRoots: string[];
  private readonly prompts: PromptTemplate[];
  private readonly promptDiagnostics: ResourceDiagnostic[];
  private readonly skillContentPaths: ReadonlyMap<string, string>;
  private readonly systemPrompt: string;
  private readonly systemPromptSource: { path: string };
  private readonly appendSystemPrompt: string[];
  private readonly appendSystemPromptSources: Array<{ path: string }>;

  public constructor(
    cwd: string,
    fileSystem: RestrictedResourceFileSystem = DEFAULT_FILE_SYSTEM,
    activeSecrets: readonly string[] = [],
    candyRoot?: string,
    skillRoots: readonly string[] = [],
  ) {
    this.fileSystem = fileSystem;
    this.activeSecrets = activeSecrets;
    this.agentsFiles = readApprovedContextFile(cwd, fileSystem, activeSecrets);
    const resources = readCandyResources(candyRoot, fileSystem, activeSecrets);
    const skills = loadCandySkills(
      [
        ...(candyRoot === undefined ? [] : [path.join(path.resolve(candyRoot), "skills")]),
        ...skillRoots,
      ],
      fileSystem,
      activeSecrets,
    );
    this.skills = skills.resources;
    this.skillDiagnostics = skills.diagnostics;
    this.skillReadRoots = skills.readRoots;
    this.skillContentPaths = skills.contentPaths;
    this.prompts = resources.prompts;
    this.promptDiagnostics = resources.promptDiagnostics;
    this.systemPrompt = resources.systemPrompt;
    this.systemPromptSource = resources.systemPromptSource;
    this.appendSystemPrompt = resources.appendSystemPrompt;
    this.appendSystemPromptSources = resources.appendSystemPromptSources;
  }

  /**
   * Real (unredacted) base directories of the successfully loaded skills.
   * Used only for read-root validation; never exposed to the model.
   */
  public getSkillReadRoots(): readonly string[] {
    return [...this.skillReadRoots];
  }

  /**
   * Read the redacted body of a loaded skill for explicit invocation
   * (/skill <name>). Revalidates the file through the restricted boundary so
   * a changed or retargeted skill fails closed. Returns undefined when the
   * skill is unknown or no longer readable.
   */
  public getSkillContent(name: string): string | undefined {
    const filePath = this.skillContentPaths.get(name);
    if (filePath === undefined) return undefined;
    const root = path.dirname(filePath);
    const file = readCandyFile(filePath, root, this.fileSystem, this.activeSecrets);
    return file?.content;
  }

  public getExtensions(): LoadExtensionsResult {
    return { extensions: [], errors: [], runtime: this.extensionRuntime };
  }

  public getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
    return {
      skills: this.skills.map((skill) => ({ ...skill })),
      diagnostics: [...this.skillDiagnostics],
    };
  }

  public getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
    return {
      prompts: this.prompts.map((prompt) => ({ ...prompt })),
      diagnostics: [...this.promptDiagnostics],
    };
  }

  public getThemes(): { themes: []; diagnostics: [] } {
    return { themes: [], diagnostics: [] };
  }

  public getAgentsFiles(): {
    agentsFiles: Array<{ path: string; content: string }>;
  } {
    return { agentsFiles: this.agentsFiles.map((file) => ({ ...file })) };
  }

  public getSystemPrompt(): string {
    return this.systemPrompt;
  }

  public getSystemPromptSource(): { path: string } {
    return { ...this.systemPromptSource };
  }

  public getAppendSystemPrompt(): string[] {
    return [...this.appendSystemPrompt];
  }

  public getAppendSystemPromptSources(): Array<{ path: string }> {
    return this.appendSystemPromptSources.map((source) => ({ ...source }));
  }

  public extendResources(paths: RestrictedResourceExtensionPaths): void {
    if (
      (paths.skillPaths?.length ?? 0) > 0 ||
      (paths.promptPaths?.length ?? 0) > 0 ||
      (paths.themePaths?.length ?? 0) > 0
    ) {
      throw new Error("Candy restricted resource loader rejects resource extensions.");
    }
  }

  public async reload(): Promise<void> {
    return Promise.resolve();
  }
}

type RestrictedResourceExtensionPaths = {
  readonly skillPaths?: readonly unknown[];
  readonly promptPaths?: readonly unknown[];
  readonly themePaths?: readonly unknown[];
};

interface CandyResources {
  readonly prompts: PromptTemplate[];
  readonly promptDiagnostics: ResourceDiagnostic[];
  readonly systemPrompt: string;
  readonly systemPromptSource: { path: string };
  readonly appendSystemPrompt: string[];
  readonly appendSystemPromptSources: Array<{ path: string }>;
}

function readCandyResources(
  candyRoot: string | undefined,
  fileSystem: RestrictedResourceFileSystem,
  activeSecrets: readonly string[],
): CandyResources {
  if (candyRoot === undefined) {
    return {
      prompts: [],
      promptDiagnostics: [],
      systemPrompt: DEFAULT_CANDY_SYSTEM_PROMPT,
      systemPromptSource: { path: "<candy-default>" },
      appendSystemPrompt: [],
      appendSystemPromptSources: [],
    };
  }

  const root = path.resolve(candyRoot);
  const system = readCandyFile(path.join(root, "SYSTEM.md"), root, fileSystem, activeSecrets);
  const append = readCandyFile(
    path.join(root, "APPEND_SYSTEM.md"),
    root,
    fileSystem,
    activeSecrets,
  );
  const promptResult = loadCandyPrompts(
    path.join(root, "prompts"),
    root,
    fileSystem,
    activeSecrets,
  );
  return {
    prompts: promptResult.resources,
    promptDiagnostics: promptResult.diagnostics,
    systemPrompt: system?.content ?? DEFAULT_CANDY_SYSTEM_PROMPT,
    systemPromptSource: { path: system?.path ?? "<candy-default>" },
    appendSystemPrompt: append === undefined ? [] : [append.content],
    appendSystemPromptSources: append === undefined ? [] : [{ path: append.path }],
  };
}

interface CandySkillsResult {
  readonly resources: Skill[];
  readonly diagnostics: ResourceDiagnostic[];
  /** Real base directories of loaded skills, used only for read-root IO validation. */
  readonly readRoots: string[];
  /**
   * Real SKILL.md paths keyed by skill name, used only for explicit skill
   * invocation; the model-visible Skill objects keep the redacted paths.
   */
  readonly contentPaths: ReadonlyMap<string, string>;
}

function loadCandySkills(
  roots: readonly string[],
  fileSystem: RestrictedResourceFileSystem,
  activeSecrets: readonly string[],
): CandySkillsResult {
  const resources: Skill[] = [];
  const diagnostics: ResourceDiagnostic[] = [];
  const readRoots: string[] = [];
  const contentPaths = new Map<string, string>();
  for (const directory of roots) {
    const walk = listCandyFiles(directory, fileSystem);
    for (const filePath of walk.files.filter(
      (candidate) => path.basename(candidate) === "SKILL.md",
    )) {
      if (resources.length >= MAX_MODEL_SKILLS) {
        diagnostics.push({
          type: "error",
          message: `skill budget exhausted at ${MAX_MODEL_SKILLS}; higher-priority roots win`,
          path: directory,
        });
        return { resources, diagnostics, readRoots, contentPaths };
      }
      const file = readCandyFile(
        filePath,
        directory,
        fileSystem,
        activeSecrets,
        walk.allowedTargets,
      );
      if (file === undefined) continue;
      const document = parseMarkdownDocument(file.content);
      const name = stringField(document.frontmatter.name);
      const description = stringField(document.frontmatter.description);
      if (name === undefined || description === undefined) {
        diagnostics.push({
          type: "error",
          message: "Candy skill requires frontmatter name and description.",
          path: file.path,
        });
        continue;
      }
      if (resources.some((skill) => skill.name === name)) {
        diagnostics.push({
          type: "collision",
          message: `skill name "${name}" collision`,
          path: file.path,
        });
        continue;
      }
      resources.push({
        name,
        description,
        filePath: file.path,
        baseDir: path.dirname(file.path),
        sourceInfo: {
          path: file.path,
          source: "candy",
          scope: "user",
          origin: "top-level",
          baseDir: path.dirname(file.path),
        },
        disableModelInvocation: document.frontmatter["disable-model-invocation"] === true,
      });
      readRoots.push(path.dirname(filePath));
      contentPaths.set(name, filePath);
    }
  }
  return { resources, diagnostics, readRoots, contentPaths };
}

function loadCandyPrompts(
  directory: string,
  root: string,
  fileSystem: RestrictedResourceFileSystem,
  activeSecrets: readonly string[],
): { resources: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
  const resources: PromptTemplate[] = [];
  const diagnostics: ResourceDiagnostic[] = [];
  for (const filePath of listCandyFiles(directory, fileSystem).files.filter((candidate) =>
    candidate.endsWith(".md"),
  )) {
    if (path.basename(filePath) === "SKILL.md") continue;
    const file = readCandyFile(filePath, root, fileSystem, activeSecrets);
    if (file === undefined) continue;
    const document = parseMarkdownDocument(file.content);
    const name = stringField(document.frontmatter.name) ?? path.basename(file.path, ".md");
    if (resources.some((prompt) => prompt.name === name)) {
      diagnostics.push({
        type: "collision",
        message: `prompt name "${name}" collision`,
        path: file.path,
      });
      continue;
    }
    const description =
      stringField(document.frontmatter.description) ?? "Candy-owned prompt template";
    const argumentHint = stringField(document.frontmatter["argument-hint"]);
    resources.push({
      name,
      description,
      ...(argumentHint === undefined ? {} : { argumentHint }),
      content: document.content,
      sourceInfo: {
        path: file.path,
        source: "candy",
        scope: "user",
        origin: "top-level",
        baseDir: path.dirname(file.path),
      },
      filePath: file.path,
    });
  }
  return { resources, diagnostics };
}

interface CandyFileWalk {
  readonly files: string[];
  /**
   * Realpath targets of directory symlinks discovered under the root.
   * Directory-level symlinks are the standard way shared skill directories
   * are installed (one source tree linked into ~/.agents/skills), so the
   * walker enters them but only after resolving and recording the target;
   * every file read is still validated against these recorded targets, which
   * fails closed when a link is retargeted between discovery and read.
   * File-level symlinks stay rejected.
   */
  readonly allowedTargets: string[];
}

function listCandyFiles(
  directory: string,
  fileSystem: RestrictedResourceFileSystem,
): CandyFileWalk {
  const pending: Array<{ directory: string; depth: number }> = [{ directory, depth: 0 }];
  const files: string[] = [];
  const allowedTargets: string[] = [];
  let directoryCount = 0;
  let totalBytes = 0;
  const empty = (): CandyFileWalk => ({ files: [], allowedTargets: [] });
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    directoryCount += 1;
    if (directoryCount > MAX_CANDY_RESOURCE_DIRECTORIES) return empty();
    let exceededDirectoryBudget = false;
    const visit = (entry: RestrictedResourceDirectoryEntry): boolean => {
      const filePath = path.join(current.directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (current.depth >= MAX_CANDY_RESOURCE_DEPTH) {
          exceededDirectoryBudget = true;
          return false;
        }
        let target: string;
        try {
          target = fileSystem.realpath(filePath);
        } catch {
          return true;
        }
        let targetStats: RestrictedResourceFileStats;
        try {
          targetStats = fileSystem.lstat(target);
        } catch {
          return true;
        }
        if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) return true;
        allowedTargets.push(target);
        pending.push({ directory: target, depth: current.depth + 1 });
        return true;
      }
      if (entry.isFile()) {
        let stats: RestrictedResourceFileStats;
        try {
          stats = fileSystem.lstat(filePath);
        } catch {
          return true;
        }
        if (!stats.isFile() || stats.isSymbolicLink()) return true;
        if (files.length >= MAX_CANDY_RESOURCE_FILES) {
          exceededDirectoryBudget = true;
          return false;
        }
        totalBytes += Math.min(stats.size, MAX_CANDY_RESOURCE_BYTES);
        if (totalBytes > MAX_CANDY_RESOURCE_TOTAL_BYTES) {
          exceededDirectoryBudget = true;
          return false;
        }
        files.push(filePath);
        return true;
      }
      if (entry.isDirectory()) {
        if (current.depth >= MAX_CANDY_RESOURCE_DEPTH) {
          exceededDirectoryBudget = true;
          return false;
        }
        pending.push({ directory: filePath, depth: current.depth + 1 });
      }
      return true;
    };
    try {
      if (fileSystem.readDirectory !== undefined) {
        let entryCount = 0;
        fileSystem.readDirectory(current.directory, (entry) => {
          entryCount += 1;
          if (entryCount > MAX_CANDY_RESOURCE_DIRECTORY_ENTRIES) {
            exceededDirectoryBudget = true;
            return false;
          }
          return visit(entry);
        });
      } else {
        const entries = fileSystem.readdir?.(current.directory) ?? [];
        if (entries.length > MAX_CANDY_RESOURCE_DIRECTORY_ENTRIES) return empty();
        for (const entry of entries) {
          if (!visit(entry)) break;
        }
      }
    } catch {
      continue;
    }
    if (exceededDirectoryBudget) return empty();
  }
  return { files: files.sort(), allowedTargets };
}

function readCandyFile(
  filePath: string,
  root: string,
  fileSystem: RestrictedResourceFileSystem,
  activeSecrets: readonly string[],
  allowedTargets: readonly string[] = [],
): { path: string; content: string } | undefined {
  try {
    const stats = fileSystem.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_CANDY_RESOURCE_BYTES)
      return undefined;
    const realPath = fileSystem.realpath(filePath);
    const realRoot = fileSystem.realpath(root);
    const withinRoot =
      isWithinRoot(realRoot, realPath) ||
      allowedTargets.some((target) => isWithinRoot(target, realPath));
    if (!withinRoot) return undefined;
    const content = readStableResource(filePath, realPath, stats, fileSystem);
    return content === undefined
      ? undefined
      : {
          path: redactCredentialMaterial(realPath, activeSecrets),
          content: redactCredentialMaterial(content, activeSecrets),
        };
  } catch {
    return undefined;
  }
}

interface MarkdownDocument {
  readonly frontmatter: Record<string, unknown>;
  readonly content: string;
}

function parseMarkdownDocument(value: string): MarkdownDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(value);
  if (match === null) return { frontmatter: {}, content: value };
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    frontmatter[key] = raw === "true" ? true : raw === "false" ? false : stripYamlQuotes(raw);
  }
  return { frontmatter, content: match[2] ?? "" };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stripYamlQuotes(value: string): string {
  return value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
}

function readApprovedContextFile(
  cwd: string,
  fileSystem: RestrictedResourceFileSystem,
  activeSecrets: readonly string[],
): Array<{ path: string; content: string }> {
  const workspaceRoot = path.resolve(cwd);
  const contextPath = path.join(workspaceRoot, CONTEXT_FILE_NAME);

  try {
    const workspaceRealPath = fileSystem.realpath(workspaceRoot);
    const contextStats = fileSystem.lstat(contextPath);
    if (!contextStats.isFile() || contextStats.isSymbolicLink()) return [];
    if (contextStats.size > MAX_CONTEXT_FILE_BYTES) return [];

    const contextRealPath = fileSystem.realpath(contextPath);
    if (!isWithinRoot(workspaceRealPath, contextRealPath)) return [];

    const content = readStableResource(contextPath, contextRealPath, contextStats, fileSystem);
    if (content === undefined) return [];

    return [
      {
        path: redactCredentialMaterial(contextRealPath, activeSecrets),
        content: redactCredentialMaterial(content, activeSecrets),
      },
    ];
  } catch {
    return [];
  }
}

function readStableResource(
  filePath: string,
  expectedRealPath: string,
  expectedStats: RestrictedResourceFileStats,
  fileSystem: RestrictedResourceFileSystem,
): string | undefined {
  const bytes = fileSystem.readFileNoFollow?.(filePath) ?? fileSystem.readFile(filePath);
  const afterStats = fileSystem.lstat(filePath);
  const afterRealPath = fileSystem.realpath(filePath);
  if (
    !afterStats.isFile() ||
    afterStats.isSymbolicLink() ||
    afterStats.size !== expectedStats.size ||
    afterRealPath !== expectedRealPath
  )
    return undefined;
  return decodeUtf8(bytes);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function decodeUtf8(value: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}
