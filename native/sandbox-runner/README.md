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

The TypeScript boundary includes the Candy parent PID in each request. The
macOS runner puts the sandboxed command in its own Candy-owned process group,
catches cancellation in the supervisor, and starts a detached reaper that
watches the Candy parent independently. The reaper terminates the complete
owned group on cancellation or parent loss, and tracks/reclaims detached
descendants after normal command completion. A zero or omitted parent PID is
retained only for direct protocol fixtures and is not emitted by the
TypeScript caller.

On Windows, the same protocol launches through the Windows 11
`Experimental_CreateProcessInSandbox` AppContainer/BFS API with a default
denied network and explicit workspace/toolchain grants, then assigns the
suspended process to a Job Object before resume. The runner rejects the
request when the API is missing or returns an unsupported-host result; it
never falls back to the older unsandboxed `CreateProcessW` path. Output is
bounded, workspace/cwd reparse paths are rejected, and the owned process tree
is cleaned up. `network: true` adds only the explicit `internetClient`
capability for that one process.

The API is experimental and host-gated. On a Windows 11 host where
`processmodel.dll` returns `ERROR_CALL_NOT_IMPLEMENTED`, the runner reports
`sandbox_unavailable` and the TUI capability remains disabled. That result is
an intentional blocked state, not evidence of OS-level containment.

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
