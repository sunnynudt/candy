import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import type { LoadExtensionsResult, ResourceLoader } from "@earendil-works/pi-coding-agent";

const MAX_CONTEXT_FILE_BYTES = 64 * 1024;
const CONTEXT_FILE_NAME = "AGENTS.md";
const REDACTED_CREDENTIAL = "[REDACTED]";

/**
 * Candy's resource boundary. Pi is allowed to consume the public ResourceLoader
 * contract, but it must not discover files, packages, or executable resources.
 */
export class CandyRestrictedResourceLoader implements ResourceLoader {
  private readonly extensionRuntime = createExtensionRuntime();

  private readonly agentsFiles: Array<{ path: string; content: string }>;

  public constructor(cwd: string) {
    this.agentsFiles = readApprovedContextFile(cwd);
  }

  public getExtensions(): LoadExtensionsResult {
    return { extensions: [], errors: [], runtime: this.extensionRuntime };
  }

  public getSkills(): { skills: []; diagnostics: [] } {
    return { skills: [], diagnostics: [] };
  }

  public getPrompts(): { prompts: []; diagnostics: [] } {
    return { prompts: [], diagnostics: [] };
  }

  public getThemes(): { themes: []; diagnostics: [] } {
    return { themes: [], diagnostics: [] };
  }

  public getAgentsFiles(): {
    agentsFiles: Array<{ path: string; content: string }>;
  } {
    return { agentsFiles: this.agentsFiles.map((file) => ({ ...file })) };
  }

  public getSystemPrompt(): undefined {
    return undefined;
  }

  public getSystemPromptSource(): undefined {
    return undefined;
  }

  public getAppendSystemPrompt(): [] {
    return [];
  }

  public getAppendSystemPromptSources(): [] {
    return [];
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

function readApprovedContextFile(cwd: string): Array<{ path: string; content: string }> {
  const workspaceRoot = path.resolve(cwd);
  const contextPath = path.join(workspaceRoot, CONTEXT_FILE_NAME);

  try {
    const workspaceRealPath = realpathSync(workspaceRoot);
    const contextStats = lstatSync(contextPath);
    if (!contextStats.isFile() || contextStats.isSymbolicLink()) return [];
    if (contextStats.size > MAX_CONTEXT_FILE_BYTES) return [];

    const contextRealPath = realpathSync(contextPath);
    if (!isWithinRoot(workspaceRealPath, contextRealPath)) return [];

    const content = decodeUtf8(readFileSync(contextPath));
    if (content === undefined) return [];

    return [{ path: contextRealPath, content: redactCredentialMaterial(content) }];
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

function redactCredentialMaterial(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/giu, `$1${REDACTED_CREDENTIAL}`)
    .replace(/\b(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,}\b/gu, REDACTED_CREDENTIAL)
    .replace(
      /((?:api[-_ ]?key|authorization|password|private[-_ ]?key|secret|token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu,
      `$1${REDACTED_CREDENTIAL}`,
    );
}
