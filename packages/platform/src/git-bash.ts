import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export type GitBashDiscoveryFailure = "missing" | "ambiguous" | "invalid";

export interface GitBashDiscoveryOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly pathEntries?: readonly string[];
  readonly registryInstallPaths?: readonly string[];
  readonly fileProbe?: (candidate: string) => "file" | "directory" | "missing";
  readonly canonicalize?: (candidate: string) => string;
}

export class GitBashDiscoveryError extends Error {
  public constructor(
    public readonly failure: GitBashDiscoveryFailure,
    message: string,
  ) {
    super(message);
    this.name = "GitBashDiscoveryError";
  }
}

/**
 * Resolve the Git for Windows Bash selected by the host. Candy accepts only
 * Bash installations proven by a PATH-selected Git executable or the known
 * Git for Windows registry installation metadata.
 */
export function discoverGitBashExecutable(options: GitBashDiscoveryOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new GitBashDiscoveryError(
      "missing",
      "Trusted Personal Preview Shell requires Git for Windows on a Windows host.",
    );
  }

  const windowsPath = path.win32;
  const probe = options.fileProbe ?? defaultFileProbe;
  const canonicalize = options.canonicalize ?? defaultCanonicalize;
  const pathCandidates = new Map<string, string>();
  const registryCandidates = new Map<string, string>();
  let invalidPathCandidateCount = 0;
  let invalidRegistryCandidateCount = 0;

  const addCandidate = (
    candidate: string,
    candidates: Map<string, string>,
    source: "path" | "registry",
    expectedRoot: string,
  ): void => {
    if (!windowsPath.isAbsolute(candidate)) {
      if (source === "path") invalidPathCandidateCount += 1;
      else invalidRegistryCandidateCount += 1;
      return;
    }
    const normalized = windowsPath.normalize(candidate);
    if (probe(normalized) !== "file") {
      if (source === "path") invalidPathCandidateCount += 1;
      else invalidRegistryCandidateCount += 1;
      return;
    }
    let canonical: string;
    try {
      canonical = windowsPath.normalize(canonicalize(normalized));
    } catch {
      if (source === "path") invalidPathCandidateCount += 1;
      else invalidRegistryCandidateCount += 1;
      return;
    }
    const canonicalRoot = canonicalizeRoot(expectedRoot, canonicalize, windowsPath);
    const expectedCanonical =
      canonicalRoot === undefined ? undefined : windowsPath.join(canonicalRoot, "bin", "bash.exe");
    if (
      !windowsPath.isAbsolute(canonical) ||
      probe(canonical) !== "file" ||
      expectedCanonical === undefined ||
      canonical.toLowerCase() !== expectedCanonical.toLowerCase() ||
      canonicalRoot?.toLowerCase() !== windowsPath.normalize(expectedRoot).toLowerCase()
    ) {
      if (source === "path") invalidPathCandidateCount += 1;
      else invalidRegistryCandidateCount += 1;
      return;
    }
    candidates.set(canonical.toLowerCase(), canonical);
  };

  const pathEntries =
    options.pathEntries ??
    splitWindowsPath(getEnvironmentValue(options.environment ?? process.env));
  for (const entry of pathEntries) {
    if (entry.length === 0 || !windowsPath.isAbsolute(entry)) continue;
    const gitExecutable = windowsPath.join(entry, "git.exe");
    if (probe(gitExecutable) !== "file") continue;
    const gitRoot = gitForWindowsRoot(gitExecutable);
    if (gitRoot === undefined) {
      invalidPathCandidateCount += 1;
      continue;
    }
    addCandidate(windowsPath.join(gitRoot, "bin", "bash.exe"), pathCandidates, "path", gitRoot);
  }

  const discoveredPathCandidates = [...pathCandidates.values()];
  if (discoveredPathCandidates.length === 1) return discoveredPathCandidates[0]!;
  if (discoveredPathCandidates.length > 1) {
    throw new GitBashDiscoveryError(
      "ambiguous",
      `Multiple valid Git for Windows Bash executables were selected by PATH: ${discoveredPathCandidates.join(", ")}. Keep one Git installation selected on PATH.`,
    );
  }

  const registryInstallPaths =
    options.registryInstallPaths ?? readGitForWindowsRegistryInstallPaths(options.environment);
  for (const installPath of registryInstallPaths) {
    if (installPath.length === 0) {
      invalidRegistryCandidateCount += 1;
      continue;
    }
    addCandidate(
      windowsPath.join(installPath, "bin", "bash.exe"),
      registryCandidates,
      "registry",
      installPath,
    );
  }

  const discovered = [...registryCandidates.values()];
  if (discovered.length === 1) return discovered[0]!;
  if (discovered.length > 1) {
    throw new GitBashDiscoveryError(
      "ambiguous",
      `Multiple valid Git for Windows Bash executables were discovered: ${discovered.join(", ")}. Keep one Git installation selected on PATH or remove the ambiguity.`,
    );
  }
  if (invalidPathCandidateCount > 0 || invalidRegistryCandidateCount > 0) {
    throw new GitBashDiscoveryError(
      "invalid",
      "Git for Windows was discovered, but its Bash executable was missing, not a regular file, or could not be canonicalized.",
    );
  }
  throw new GitBashDiscoveryError(
    "missing",
    "Git for Windows Bash was not found. Install Git for Windows or make its git.exe available on PATH.",
  );
}

function canonicalizeRoot(
  root: string,
  canonicalize: (candidate: string) => string,
  windowsPath: typeof path.win32,
): string | undefined {
  try {
    const canonical = windowsPath.normalize(canonicalize(windowsPath.normalize(root)));
    return windowsPath.isAbsolute(canonical) ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function splitWindowsPath(environmentValue: string | undefined): readonly string[] {
  return environmentValue === undefined ? [] : environmentValue.split(";");
}

function getEnvironmentValue(environment: NodeJS.ProcessEnv): string | undefined {
  return getNamedEnvironmentValue(environment, "path");
}

function gitForWindowsRoot(gitExecutable: string): string | undefined {
  const windowsPath = path.win32;
  const gitDirectory = windowsPath.dirname(gitExecutable);
  const directoryName = windowsPath.basename(gitDirectory).toLowerCase();
  if (directoryName === "cmd" || directoryName === "bin") return windowsPath.dirname(gitDirectory);
  return undefined;
}

function defaultFileProbe(candidate: string): "file" | "directory" | "missing" {
  try {
    return statSync(candidate).isFile() ? "file" : "directory";
  } catch {
    return "missing";
  }
}

function defaultCanonicalize(candidate: string): string {
  return realpathSync.native(candidate);
}

function readGitForWindowsRegistryInstallPaths(
  environment: NodeJS.ProcessEnv | undefined,
): readonly string[] {
  const systemRoot =
    getNamedEnvironmentValue(environment ?? process.env, "systemroot") ?? "C:\\Windows";
  const registryExecutable = path.win32.join(systemRoot, "System32", "reg.exe");
  const keys = [
    "HKCU\\Software\\GitForWindows",
    "HKLM\\Software\\GitForWindows",
    "HKLM\\Software\\WOW6432Node\\GitForWindows",
  ];
  const results: string[] = [];
  for (const key of keys) {
    try {
      const output = execFileSync(registryExecutable, ["query", key, "/v", "InstallPath"], {
        cwd: systemRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: 1_000,
        env: {
          SystemRoot: systemRoot,
          windir: systemRoot,
        },
      });
      const match = output.match(/\bInstallPath\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)\s*$/imu);
      if (match?.[1] !== undefined) results.push(match[1].trim());
    } catch {
      // Missing registry metadata is handled by the normal fail-closed result.
    }
  }
  return results;
}

function getNamedEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return undefined;
}
