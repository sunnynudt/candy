# Issue #2 Windows native sandbox checkpoint

Status: Blocked on the current Windows host. Trusted Shell Auto remains
disabled. This is implementation evidence, not a claim that Issue #2 is
complete.

## Implementation

- The Windows native runner now resolves `processmodel.dll` from System32 and
  calls `Experimental_CreateProcessInSandbox` dynamically.
- When the experimental API returns `ERROR_CALL_NOT_IMPLEMENTED (120)`, the
  runner uses standard AppContainer `SECURITY_CAPABILITIES` only for
  validator/workspace containment. Requests requiring process execution return
  `sandbox_capability_unavailable`; they do not enter an unverified fallback.
- The experimental path emits an AppContainer FlatBuffer with
  `app_container=true`, recursive read/write access only for the canonical
  worktree, read-only grants for the approved toolchain and Git metadata, and
  no network capability for ordinary commands.
- A network command receives the separate `internetClient` capability only
  when its existing Candy approval path has approved that one command.
- Job Object ownership, pre-resume path revalidation, bounded output, and
  credential rejection remain in force.
- API absence or unsupported-host results return a sandbox capability error;
  the previous unsandboxed `CreateProcessW` path is not used. Trusted Shell
  Auto remains gated because the current ordinary-user session cannot create
  the AppContainer profile required by the native path.

## Host evidence

Environment: Windows 11 x64, Node `22.23.2`, npm `10.9.8`, Rust MSVC, native
runner built from the current worktree.

`C:\Windows\System32\processmodel.dll` exists and exports the requested
entry point, but the launch call returns Windows
`ERROR_CALL_NOT_IMPLEMENTED (120)`. A direct native probe also returns
`E_ACCESSDENIED` from `CreateAppContainerProfile` for fresh per-request
identities, so the current smoke reports `BLOCKED` before any command is
created. This is an explicit capability block; no unrestricted fallback is
used. The accepted prior checkpoint passed validator/workspace containment,
outside-workspace reads/writes, loopback denial, reparse rejection, bounded
output, and Job Object cleanup, but it did not establish current-source
Trusted Shell toolchain evidence.

The source gate remains `approved: false`; no Trusted Shell Auto enablement is
claimed. The complete Issue #2 negative matrix still requires a host that can
create the AppContainer profile, accepted Git Bash/toolchain execution through
the experimental process-exec path, current-source parent-loss/timeout
evidence, and a capability attestation for the native backend. The strict acceptance entry point is
`npm run smoke:native:windows:strict`; on this host it fails with the same
explicit `sandbox_profile_failed` block rather than treating the matrix as a
pass.
