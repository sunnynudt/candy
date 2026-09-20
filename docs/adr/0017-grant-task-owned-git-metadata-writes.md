---
status: accepted
---

# Grant task-owned Git metadata writes to Trusted Shell Auto

Candy's local-command policy already allows structural Git subcommands in an
Auto task (`git branch`, `git checkout`, `git switch`, `git merge`,
`git rebase`, `git restore`, `git reset`, ...) and refuses commit and push, which
remain available only through `candy_git_commit` and the task's `/push allow`
authorization. The macOS containment profile contradicted that policy: every
Git metadata path was registered read-only, so those subcommands failed with
`Operation not permitted` in every workspace shape, and in the common case the
model was told the command was allowed and then hit an OS denial.

The contradiction is worst for a linked Worktree (for example a Workspace under
`<repo>/.claude/worktrees/<name>`): its gitdir and common directory live outside
the selected workspace, so no workspace-scoped grant can ever reach them.

## Decision

The Candy control plane splits a shell run's path policy into two lists:

- `readOnlyPaths` — paths the OS profile may read and never write (the Node
  runtime root, a trusted dependency directory, and the `.git` marker file that
  points a linked Worktree at its gitdir), and
- `writablePaths` — the task's own Git metadata outside the workspace (the
  Worktree gitdir and its common directory), which the profile may read and
  write.

The native Sandbox Runner applies both lists as bounded subpath rules and never
decides which paths they contain. A repository whose own `.git` directory lives
inside the workspace needs no extra grant: the workspace is already writable,
and the marker is no longer pinned read-only there.

Commit and push remain refused in a local command, and the destructive Git
forms that discard a user's uncommitted work (`--hard`, `--force`,
`--force-with-lease`, `-f`, `--discard-changes`) are refused before approval or
spawn. The `.git` marker is listed in the read-only set and the grant never
contains the workspace root, so no request can widen a task beyond its own
repository metadata.

Windows fails closed: the Windows backend does not implement this grant and its
Trusted Shell Auto and Full Access gates are closed, so a request carrying
`writablePaths` is rejected instead of silently running with narrower
capability than the task authorized.

## Consequences

A Trusted Shell Auto task can now create a branch, merge, and resolve conflicts
in its own repository, including in a linked Worktree, without Full Access.

The grant covers only the task's own metadata: writes into the repository
checkout outside the workspace, and writes anywhere else on the filesystem,
stay denied. Git hooks and repository configuration live under the granted
subpath and are therefore writable; Candy's command policy already refuses
`git config`, and the workspace's own hook and CI files are writable in the same
trust class, but changes under `.git` are not part of task change review.

The macOS strict containment matrix now asserts the granted structural writes,
that a repointed Worktree marker cannot widen the grant, and that the repository
checkout stays unwritable, instead of the previous all-metadata denial. Older
implementation entries that recorded "Git metadata/ref/reflog write denial"
describe the superseded profile and are superseded for this property; platform
enablement from ADR-0010 is unchanged.

## Measured profile semantics

The macOS profile is default-deny and resolves one operation by the **last
matching rule**; being merely more specific than a later rule does not win. The
workspace write allow is emitted last, so the explicit write denial produced by
`readOnlyPaths` has no effect for paths **inside** the workspace. Measured on
2026-09-11: a shell run could rewrite its own Worktree `.git` marker, which had
been assumed to be read-only.

Paths outside the workspace are unaffected because nothing allows them: that
default deny is what refused Git metadata writes before this ADR, and it is what
keeps the new grant bounded. Making the explicit denies effective would mean
emitting them after the workspace allow, which also turns a trusted dependency
directory inside the workspace into a write-protected path and can break local
commands that cache inside `node_modules`; that is a separate change with its
own verification, and it is not part of this decision.

The `.git` marker is not a security boundary either way: Candy's own file tools
write workspace files without a `.git` exclusion, so the marker is an ordinary
workspace file whose change is visible in task change review.
