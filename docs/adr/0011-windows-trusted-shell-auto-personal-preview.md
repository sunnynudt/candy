# Windows Trusted Shell Auto Personal Preview gate

Status: Accepted as a source-gated implementation boundary

## Decision

Candy keeps Windows Trusted Shell Auto disabled in the normal TUI composition
root until a Windows-specific native capability attestation is accepted. The
attestation must cover the current Windows x64 build, the versioned native
runner protocol, and operating-system enforcement of all of the following:

- canonical Task Worktree containment, including reparse-point replacement;
- default-denied ordinary-command network access;
- a separate one-command network capability;
- Job Object ownership and cleanup for every descendant;
- the reviewed Git for Windows Bash executable and approved toolchain surface.

The immutable source attestation currently records the native backend as
`windows-appcontainer-job-v1` and remains `approved: false`. The runner calls
the Windows 11 `Experimental_CreateProcessInSandbox` entry point from System32
and encodes the `SBOX` AppContainer specification. This is the only native
path that may satisfy the Trusted Shell process-exec capability. If the
experimental entry point returns `ERROR_CALL_NOT_IMPLEMENTED` (120), the
standard AppContainer `SECURITY_CAPABILITIES` path is retained only for
validator/workspace containment; requests requiring process execution return
`sandbox_capability_unavailable`. No undocumented policy-broker or ACL
fallback is treated as Trusted Shell containment, and no unsandboxed process
path is used. The current host cannot create the AppContainer profile under
its ordinary-user policy, so this checkpoint does not enable Trusted Shell
Auto.

## Consequences

The base Windows TUI remains usable for Read-only inspection, File Auto, task
worktrees, review, Apply, validators, and recovery. `:trusted-shell on` fails
closed with an actionable capability message. Git Bash discovery is still
implemented and tested independently so a future accepted native backend can
reuse the selected Git for Windows installation without adding a user-selected
shell path or a fallback to PowerShell, cmd, WSL, or an unrelated Bash.

The macOS Personal Preview gate is independent. macOS evidence cannot enable
Windows, and an environment variable or other user-controlled runtime value
cannot enable either platform gate.

## Required evidence before enabling

An enablement change must run on a host where the native API is implemented,
add the reviewed Windows native backend evidence, and rerun the Windows
negative matrix for outside reads/writes, junctions and reparse-point swaps,
network denial and one-command elevation, descendant cleanup, timeout,
cancellation, parent loss, and ordinary-user execution. It must then record
the exact source revision, native digest, protocol version, Windows build,
architecture, Node/npm/Pi closure, Git for Windows version, and TUI evidence.
