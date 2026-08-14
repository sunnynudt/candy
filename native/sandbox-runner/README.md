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
macOS runner keeps the helper and sandboxed command in the same Candy-owned
detached process group so ordinary cancellation terminates both; while a
command is active it also watches the parent PID and terminates that group if
Candy exits unexpectedly. A zero or omitted parent PID is retained only for
direct protocol fixtures and is not emitted by the TypeScript caller.

On Windows, the same protocol launches a suspended absolute executable,
assigns it to a Job Object before resume, enables `KILL_ON_JOB_CLOSE`, bounds
output, rejects workspace/cwd reparse paths, and cleans up the owned process
tree. The Windows `network: false` field is protocol validation, not OS-level
network isolation.

The macOS strict-containment smoke proves supported validator execution,
outside-workspace read/write denial, symlink and symlink-swap denial, loopback
network denial, ordinary descendant cancellation, and cleanup after the
native runner's parent is killed on the acceptance host. This is still not a
completed G2 security review: independent review, signed packaging, Windows
OS-level containment, and final cross-platform evidence remain open. Candy
must keep shell-enabled Auto and Auto Debug unavailable until both native
backends pass those checks.
