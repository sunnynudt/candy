# Issue #2 Windows native sandbox checkpoint

Status: Blocked on the current Windows host. Trusted Shell Auto remains
disabled. This is implementation evidence, not a claim that Issue #2 is
complete.

## Implementation

- The Windows native runner now resolves `processmodel.dll` from System32 and
  calls `Experimental_CreateProcessInSandbox` dynamically.
- The runner emits an AppContainer/BFS FlatBuffer with `app_container=true`,
  recursive read/write access only for the canonical worktree, read-only
  grants for the approved toolchain and Git metadata, and no network
  capability for ordinary commands.
- A network command receives the separate `internetClient` capability only
  when its existing Candy approval path has approved that one command.
- Job Object ownership, pre-resume path revalidation, bounded output, and
  credential rejection remain in force.
- API absence or unsupported-host results return `sandbox_unavailable`; the
  previous unsandboxed `CreateProcessW` path is not used.

## Host evidence

Environment: Windows 11 x64, Node `22.23.2`, npm `10.9.8`, Rust MSVC, native
runner built from the current worktree.

`C:\Windows\System32\processmodel.dll` exists and exports the requested
entry point, but the launch call returns Windows
`ERROR_CALL_NOT_IMPLEMENTED (120)`. The Windows native smoke therefore
reports:

`BLOCKED: Windows AppContainer/BFS native sandbox is unavailable on this host; no unsandboxed fallback was used`

The source gate remains `approved: false`; no Trusted Shell Auto enablement is
claimed. The complete Issue #2 negative matrix still requires a host that can
execute the accepted OS-level boundary.
