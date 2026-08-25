# Candy Sandbox Runner

This is the narrow Rust process boundary permitted by ADR-0005. It owns no
task, provider, credential, workspace-policy, approval, session, or UI logic.

The macOS binary canonicalizes the workspace, cwd, and executable, rejects a
cwd outside the workspace, then launches the exact executable through
`/usr/bin/sandbox-exec` under a default-deny Seatbelt profile importing
`system.sb`. The profile denies network access, permits only the validator
executable and its runtime reads, and permits reads/writes under the
canonicalized workspace. It also clears the child environment, bounds output,
and returns a typed completion response. The TypeScript caller separately
enforces selected-workspace policy and provider-secret isolation.

`processExecPaths` may be supplied without the wide `allowProcessExec` policy:
it then grants `process-exec` plus `file-read*/file-map-executable` for only
those explicit subpaths, keeping the literal-executable default otherwise.
The network elevation tool uses this to let the real git binary spawn its
`git-remote-https` helper and load its libraries (git-core and lib dirs under
the resolved git root) without opening the offline shell policy.

The TypeScript boundary includes the Candy parent PID in each request. The
macOS runner puts the sandboxed command in its own Candy-owned process group,
catches cancellation in the supervisor, and starts a detached reaper that
watches the Candy parent independently. The reaper terminates the complete
owned group on cancellation or parent loss, and tracks/reclaims detached
descendants after normal command completion. A zero or omitted parent PID is
retained only for direct protocol fixtures and is not emitted by the
TypeScript caller.

On Windows, the same protocol first launches through the Windows 11
`Experimental_CreateProcessInSandbox` AppContainer API with a default-denied
network and explicit workspace/toolchain grants, then assigns the suspended
process to a Job Object before resume. This is the only native path that may
provide the Trusted Shell process-exec capability. When that experimental entry
point returns `ERROR_CALL_NOT_IMPLEMENTED`, the runner uses the standard
AppContainer `SECURITY_CAPABILITIES` launch path only for validator/workspace
containment. Requests requiring process execution fail closed with
`sandbox_capability_unavailable`. There is no undocumented policy-broker
fallback and no unsandboxed `CreateProcessW` fallback.
Output is bounded, workspace/cwd reparse paths are rejected, and the owned
process tree is cleaned up. `network: true` adds only the explicit
`internetClient` capability for that one process.

The experimental API remains host-gated. The accepted prior checkpoint proved
the standard validator/workspace path, but the current Windows session denies
`CreateAppContainerProfile` with `E_ACCESSDENIED`, so it cannot produce fresh
Trusted Shell evidence. Trusted Shell Auto remains disabled. That is an
intentional blocked state, not a claim of complete Windows Trusted Shell
acceptance.

The Windows smoke reports an unavailable host as `BLOCKED` for ordinary local
development. Acceptance runners must pass `--require-native` (or set
`CANDY_REQUIRE_WINDOWS_NATIVE=1`) so an unavailable containment capability
fails the run instead of being treated as a successful matrix.

The macOS strict-containment smoke proves supported validator execution,
outside-workspace read/write denial, symlink and symlink-swap denial, loopback
network denial, ordinary and detached descendant cleanup, and cleanup after
the native runner's parent is killed on the acceptance host. It is not a
completed macOS G2 security review. Under ADR-0010, macOS Personal Preview
enablement is independently gated from Windows; the macOS composition root
must keep shell-enabled Auto and Auto Debug unavailable until the macOS G2
review and its cancellation/process-tree evidence pass. Windows remains
separately gated on its own native review, and signed packaging plus final
cross-platform evidence remain open.
