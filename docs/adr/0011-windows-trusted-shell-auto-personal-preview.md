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

The immutable source attestation records the native backend as
`windows-appcontainer-job-v1` and remains `approved: false`. The runner
prefers the documented standard AppContainer `SECURITY_CAPABILITIES` launch
path, with default-denied network, explicit workspace/toolchain grants, and
Job Object ownership. It consults the Windows 11 experimental
`Experimental_CreateProcessInSandbox` API only when the documented backend is
unavailable before it creates a child. No undocumented policy-broker, ACL-only,
or unsandboxed process path is treated as Trusted Shell containment. The strict
native smoke passes ordinary Node execution, workspace/reparse denial, default
network denial plus one-command elevation, bounded output, cancellation,
descendant cleanup, and parent-loss cleanup. However, this host's
administrator-owned custom Git for Windows installation cannot receive a
temporary AppContainer DACL grant from an ordinary Candy process, so it cannot
yet prove the real Bash Tool Host path.

## Consequences

The base Windows TUI remains usable for Read-only inspection, File Auto, task
worktrees, review, Apply, validators, and recovery. `:trusted-shell on` fails
closed with an actionable capability message. Git Bash discovery remains
Candy-owned: it does not accept a user-selected shell path or fall back to
PowerShell, cmd, WSL, or an unrelated Bash. The future implementation must
either package an AppContainer-readable Git toolchain or preflight a compatible
installation without adding per-command approval.

The macOS Personal Preview gate is independent. macOS evidence cannot enable
Windows, and an environment variable or other user-controlled runtime value
cannot enable either platform gate.

## Required evidence before enabling

An enablement change must prove both the native negative matrix and Git Bash
Tool Host execution under ordinary-user permissions. Full Access remains
separately gated: dynamic AppContainer capability SIDs do not provide broad
filesystem access; it needs a stable Windows package identity and
broad-filesystem entitlement evidence.
