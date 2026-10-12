// Platform support policy: which host versions may produce V1 acceptance
// evidence. ADR-0018 supersedes the ADR-0012 version-pin clause: the harness
// accepts any host at or above the documented floor and always records the
// exact version. Raising the floor or claiming support for a new macOS major
// is a contract/ADR change, not a code edit.

/**
 * Minimum macOS product version that may produce V1 acceptance evidence.
 * Numeric floor with no upper bound; the harness records the exact version.
 */
export const macosMinimumVersion = Object.freeze({ major: 26, minor: 5, patch: 2 });

/**
 * Required architecture for macOS acceptance evidence.
 */
export const macosArchitecture = "arm64";
