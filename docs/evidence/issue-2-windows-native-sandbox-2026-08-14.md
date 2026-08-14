# Issue #2 Windows native sandbox checkpoint

Status: Blocked on the current Windows host. Trusted Shell Auto remains
disabled. This is implementation evidence, not a claim that Issue #2 is
complete.

## Implementation

- The Windows native runner now resolves `processmodel.dll` from System32 and
  calls `Experimental_CreateProcessInSandbox` dynamically.
- When the experimental API returns `ERROR_CALL_NOT_IMPLEMENTED (120)`, the
  runner uses standard AppContainer `SECURITY_CAPABILITIES` with temporary
  package-SID ACLs for the canonical workspace and explicit read-only roots;
  ACL failure remains fail-closed. Because standard AppContainer has no
  equivalent process-exec allowlist, the fallback also rejects Trusted Shell
  requests that require `allowProcessExec`.
- The runner emits an AppContainer/BFS FlatBuffer with `app_container=true`,
  recursive read/write access only for the canonical worktree, read-only
  grants for the approved toolchain and Git metadata, and no network
  capability for ordinary commands.
- A network command receives the separate `internetClient` capability only
  when its existing Candy approval path has approved that one command.
- Job Object ownership, pre-resume path revalidation, bounded output, and
  credential rejection remain in force.
- API absence or unsupported-host results return `sandbox_unavailable`; the
  previous unsandboxed `CreateProcessW` path is not used. Trusted Shell Auto
  remains gated because the current ordinary-user Git installation cannot be
  granted the required temporary package-SID ACL.

## Host evidence

Environment: Windows 11 x64, Node `22.23.2`, npm `10.9.8`, Rust MSVC, native
runner built from the current worktree.

`C:\Windows\System32\processmodel.dll` exists and exports the requested
entry point, but the launch call returns Windows
`ERROR_CALL_NOT_IMPLEMENTED (120)`. The standard AppContainer fallback then
passes the validator/workspace negative smoke on this host: workspace writes
work, outside-workspace reads/writes and loopback network are denied, reparse
paths are rejected, output is bounded, and Job Object descendants are
reclaimed. The Git Bash/toolchain ACL cannot be applied as an ordinary user,
so the Trusted Shell acceptance gate remains blocked.

The source gate remains `approved: false`; no Trusted Shell Auto enablement is
claimed. The complete Issue #2 negative matrix still requires accepted Git Bash
and toolchain execution, parent-loss/timeout evidence, and a capability
attestation for the standard fallback or an implemented experimental backend.
