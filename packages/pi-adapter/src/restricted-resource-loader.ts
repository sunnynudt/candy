import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import type {
  LoadExtensionsResult,
  PromptTemplate,
  ResourceDiagnostic,
  ResourceLoader,
  Skill,
} from "@earendil-works/pi-coding-agent";

const MAX_CONTEXT_FILE_BYTES = 64 * 1024;
const MAX_CANDY_RESOURCE_BYTES = 64 * 1024;
const CONTEXT_FILE_NAME = "AGENTS.md";
const REDACTED_CREDENTIAL = "[REDACTED]";
const DEFAULT_CANDY_SYSTEM_PROMPT =
  "Candy is a local-first coding agent. Keep provider credentials, session content, and diagnostics inside Candy's approved boundaries. Use the selected workspace only and report bounded evidence.";

interface RestrictedResourceFileStats {
  readonly size: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface RestrictedResourceFileSystem {
  lstat(filePath: string): RestrictedResourceFileStats;
  readFile(filePath: string): Buffer;
  realpath(filePath: string): string;
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
  realpath: (filePath) => realpathSync(filePath),
  readdir: (directory) => readdirSync(directory, { withFileTypes: true }),
};

/**
 * Candy's resource boundary. Pi is allowed to consume the public ResourceLoader
 * contract, but it must not discover files, packages, or executable resources.
 */
export class CandyRestrictedResourceLoader implements ResourceLoader {
  private readonly extensionRuntime = createExtensionRuntime();

  private readonly agentsFiles: Array<{ path: string; content: string }>;
  private readonly skills: Skill[];
  private readonly skillDiagnostics: ResourceDiagnostic[];
  private readonly prompts: PromptTemplate[];
  private readonly promptDiagnostics: ResourceDiagnostic[];
  private readonly systemPrompt: string;
  private readonly systemPromptSource: { path: string };
  private readonly appendSystemPrompt: string[];
  private readonly appendSystemPromptSources: Array<{ path: string }>;

  public constructor(
    cwd: string,
    fileSystem: RestrictedResourceFileSystem = DEFAULT_FILE_SYSTEM,
    activeSecrets: readonly string[] = [],
    candyRoot?: string,
  ) {
    this.agentsFiles = readApprovedContextFile(cwd, fileSystem, activeSecrets);
    const resources = readCandyResources(candyRoot, fileSystem, activeSecrets);
    this.skills = resources.skills;
    this.skillDiagnostics = resources.skillDiagnostics;
    this.prompts = resources.prompts;
    this.promptDiagnostics = resources.promptDiagnostics;
    this.systemPrompt = resources.systemPrompt;
    this.systemPromptSource = resources.systemPromptSource;
    this.appendSystemPrompt = resources.appendSystemPrompt;
    this.appendSystemPromptSources = resources.appendSystemPromptSources;
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
  readonly skills: Skill[];
  readonly skillDiagnostics: ResourceDiagnostic[];
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
      skills: [],
      skillDiagnostics: [],
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
  const skillResult = loadCandySkills(path.join(root, "skills"), root, fileSystem, activeSecrets);
  const promptResult = loadCandyPrompts(
    path.join(root, "prompts"),
    root,
    fileSystem,
    activeSecrets,
  );
  return {
    skills: skillResult.resources,
    skillDiagnostics: skillResult.diagnostics,
    prompts: promptResult.resources,
    promptDiagnostics: promptResult.diagnostics,
    systemPrompt: system?.content ?? DEFAULT_CANDY_SYSTEM_PROMPT,
    systemPromptSource: { path: system?.path ?? "<candy-default>" },
    appendSystemPrompt: append === undefined ? [] : [append.content],
    appendSystemPromptSources: append === undefined ? [] : [{ path: append.path }],
  };
}

function loadCandySkills(
  directory: string,
  root: string,
  fileSystem: RestrictedResourceFileSystem,
  activeSecrets: readonly string[],
): { resources: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const resources: Skill[] = [];
  const diagnostics: ResourceDiagnostic[] = [];
  for (const filePath of listCandyFiles(directory, fileSystem).filter(
    (candidate) => path.basename(candidate) === "SKILL.md",
  )) {
    const file = readCandyFile(filePath, root, fileSystem, activeSecrets);
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
  }
  return { resources, diagnostics };
}

function loadCandyPrompts(
  directory: string,
  root: string,
  fileSystem: RestrictedResourceFileSystem,
  activeSecrets: readonly string[],
): { resources: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
  const resources: PromptTemplate[] = [];
  const diagnostics: ResourceDiagnostic[] = [];
  for (const filePath of listCandyFiles(directory, fileSystem).filter((candidate) =>
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

function listCandyFiles(directory: string, fileSystem: RestrictedResourceFileSystem): string[] {
  let entries: readonly RestrictedResourceDirectoryEntry[] | undefined;
  try {
    entries = fileSystem.readdir?.(directory);
  } catch {
    return [];
  }
  if (entries === undefined) return [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isFile()) files.push(filePath);
    else if (entry.isDirectory()) files.push(...listCandyFiles(filePath, fileSystem));
  }
  return files.sort();
}

function readCandyFile(
  filePath: string,
  root: string,
  fileSystem: RestrictedResourceFileSystem,
  activeSecrets: readonly string[],
): { path: string; content: string } | undefined {
  try {
    const stats = fileSystem.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_CANDY_RESOURCE_BYTES)
      return undefined;
    const realPath = fileSystem.realpath(filePath);
    const realRoot = fileSystem.realpath(root);
    if (!isWithinRoot(realRoot, realPath)) return undefined;
    const content = decodeUtf8(fileSystem.readFile(filePath));
    return content === undefined
      ? undefined
      : { path: realPath, content: redactCredentialMaterial(content, activeSecrets) };
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

    const content = decodeUtf8(fileSystem.readFile(contextPath));
    if (content === undefined) return [];

    return [{ path: contextRealPath, content: redactCredentialMaterial(content, activeSecrets) }];
  } catch {
    return [];
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function decodeUtf8(value: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}

function redactCredentialMaterial(value: string, activeSecrets: readonly string[]): string {
  return activeSecrets
    .reduce(
      (result, secret) =>
        secret.length === 0 ? result : result.split(secret).join(REDACTED_CREDENTIAL),
      value,
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/giu, `$1${REDACTED_CREDENTIAL}`)
    .replace(/\b(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,}\b/gu, REDACTED_CREDENTIAL)
    .replace(
      /((?:api[-_ ]?key|authorization|password|private[-_ ]?key|secret|token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu,
      `$1${REDACTED_CREDENTIAL}`,
    );
}
