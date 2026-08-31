import { discoverGitBashExecutable, GitBashDiscoveryError } from "./git-bash.js";

/**
 * Windows Trusted Shell is intentionally source-gated. The standard
 * AppContainer and Job Object backend has passed its Node negative matrix, but
 * the current host's administrator-owned Git for Windows installation is not
 * AppContainer-readable. Keep the TUI shell disabled until a compatible
 * toolchain is packaged or preflighted; environment variables and other
 * user-controlled runtime state cannot enable it.
 */
const WINDOWS_TRUSTED_SHELL_AUTO_ATTESTATION = Object.freeze({
  approved: false,
  platform: "win32",
  architecture: "x64",
  nativeBackend: "windows-appcontainer-job-v1",
} as const);

export interface WindowsTrustedShellCapabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly nativeContainmentAccepted?: boolean;
  readonly discoverBash?: () => string;
}

export interface WindowsTrustedShellCapabilityStatus {
  readonly available: boolean;
  readonly reason: string;
  readonly bashPath?: string;
}

/**
 * Return the user-visible state of the Windows Personal Preview gate.
 *
 * `nativeContainmentAccepted` exists only for deterministic contract tests and
 * is never supplied by the normal composition root. The production default is
 * the immutable source attestation above; environment variables cannot enable
 * this capability.
 */
export function getWindowsTrustedShellCapabilityStatus(
  options: WindowsTrustedShellCapabilityOptions = {},
): WindowsTrustedShellCapabilityStatus {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (platform !== WINDOWS_TRUSTED_SHELL_AUTO_ATTESTATION.platform) {
    return {
      available: false,
      reason: "Windows local commands require a Windows host.",
    };
  }
  if (architecture !== WINDOWS_TRUSTED_SHELL_AUTO_ATTESTATION.architecture) {
    return {
      available: false,
      reason: "Windows local commands require an x64 host.",
    };
  }

  let bashPath: string;
  try {
    bashPath = (options.discoverBash ?? discoverGitBashExecutable)();
  } catch (error) {
    return {
      available: false,
      reason:
        error instanceof GitBashDiscoveryError
          ? error.message
          : "Git for Windows Bash could not be validated.",
    };
  }

  const containmentAccepted =
    options.nativeContainmentAccepted ?? WINDOWS_TRUSTED_SHELL_AUTO_ATTESTATION.approved;
  if (!containmentAccepted) {
    return {
      available: false,
      bashPath,
      reason:
        "Windows local commands are unavailable until the native workspace and network containment gate is accepted.",
    };
  }
  return {
    available: true,
    bashPath,
    reason: "Windows local commands are available.",
  };
}

export function isWindowsTrustedShellAutoAvailable(): boolean {
  return getWindowsTrustedShellCapabilityStatus().available;
}

export function isTrustedShellAutoAvailable(): boolean {
  // macOS has an implementation path, but its independent G2 decision is
  // still open. Keep the normal composition-root capability fail-closed until
  // that gate is accepted; host platform and architecture alone are not an
  // attestation.
  return isWindowsTrustedShellAutoAvailable();
}
