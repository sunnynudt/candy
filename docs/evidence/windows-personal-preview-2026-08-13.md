# Windows Personal Preview implementation evidence — 2026-08-13

This is a deterministic implementation checkpoint for the Windows Personal Preview slice. It is not Windows Release Pass, complete G2, or final Candy V1 acceptance.

## Scope

- Pi `0.84.1` `createBashToolDefinition()` is reused with `noTools: "builtin"`.
- Candy supplies the `BashOperations` implementation; Pi's local Bash backend is not used.
- Windows uses the fixed executable `C:\Program Files\Git\bin\bash.exe` with `--noprofile --norc -c <command>`.
- Execution is delegated to Candy's Native Process Runner and is enabled only for an explicit Personal Preview Shell task.
- A command is approved before execution, and the approval preview contains only command, Task Worktree cwd, and optional timeout.
- Personal Preview Shell requires the Auto profile, a Git-backed Task Worktree, and the Task Worktree as cwd.
- Timeout, task cancellation, credential-shaped command rejection, allowlisted child environment, output redaction, and no-replay cancellation are covered by deterministic tests.

## Verification

- Node `v22.23.2`; npm `10.9.8`.
- `tsc -b --pretty false`: passed.
- `scripts/run-tests.mjs`: **136 passed, 0 failed**.
- Coverage includes Pi Bash argv, approval ordering, cwd containment, non-Git rejection before Worktree creation, timeout/abort propagation, credential rejection before approval/spawn, approval projection, and cancellation without replay.
- Existing Git Worktree review, Apply, and Discard fixtures remain green.

## Windows host limitation

The required fixed Git Bash executable is not present on this host, so real command execution was not attempted and the adapter fails closed with a clear missing-executable error. No alternative Git installation path is substituted. Deterministic tests use an injected runner and do not claim live Provider or live Shell evidence.

## Security boundary

Personal Preview Shell runs with the current Windows user's permissions and may access files outside the workspace or the network. Job Object ownership and cancellation do not provide OS-level workspace or network containment. Shell Auto, Shell Auto Debug, AppContainer/WFP containment, signing, and independent security review remain outside this checkpoint.
