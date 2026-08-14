---
status: accepted
supersedes: ADR-0005 (platform enablement consequence only)
---

# Enable macOS Trusted Shell Auto as a gated Personal Preview

Candy may expose Trusted Shell Auto in the macOS TUI Personal Preview after the
macOS-specific G2 gate is accepted, when the user explicitly selects it for an
Auto task and the task has a Candy-owned Git Task Worktree. The composition
root enables the capability only on the accepted macOS arm64 host boundary.
This is a platform-scoped enablement decision: macOS evidence and review do
not imply Windows enablement, and Windows Trusted Shell Auto remains
unavailable until its own native G2 gates pass. The gate is derived from the
runtime platform and architecture, never from an environment variable or a
user-controlled setting.

The TUI remains the approval and task-control owner. Ordinary shell commands
use the native runner with the offline capability. A command that needs
outbound network access uses a separate one-command tool, displays the full
bounded command, reason, canonical Worktree cwd, and timeout, and requires one
explicit user decision. The network capability is not retained for later
commands.

This ADR changes only the platform enablement consequence in ADR-0005. The
macOS arm64 G2 review and current-host real-terminal/provider evidence are
recorded in the Issue #3 implementation checkpoint; exact `26.5.2` regression,
Windows parity, packaging, and product-owner acceptance remain separate. This
Personal Preview is not a release capability. Shell-based Auto Debug remains
separately gated.
