---
status: accepted
supersedes: ADR-0005 (platform enablement consequence only)
---

# Enable macOS Trusted Shell Auto as a gated Personal Preview

Candy may expose Trusted Shell Auto in the macOS TUI Personal Preview after the
macOS-specific G2 gate is accepted, when the user explicitly selects it for an
Auto task and the task has a Candy-owned Git Task Worktree. The composition
root keeps the capability flag off until that review. This is a
platform-scoped enablement decision: macOS evidence and review do not imply
Windows enablement, and Windows Trusted Shell Auto remains unavailable until
its own native G2 gates pass.

The TUI remains the approval and task-control owner. Ordinary shell commands
use the native runner with the offline capability. A command that needs
outbound network access uses a separate one-command tool, displays the full
bounded command, reason, canonical Worktree cwd, and timeout, and requires one
explicit user decision. The network capability is not retained for later
commands.

This ADR changes only the platform enablement consequence in ADR-0005. It does
not waive the acceptance evidence in `docs/product/acceptance-v1.md`: macOS
G2, real-terminal and provider journeys, independent security review,
packaging, and product-owner acceptance remain required before this Personal
Preview can be called a release capability. Shell-based Auto Debug remains
separately gated.
