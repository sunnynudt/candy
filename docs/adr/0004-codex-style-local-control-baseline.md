---
status: accepted
---

# Adopt a Codex-style local control baseline

Candy V1 uses Codex's public product behavior as the baseline for local control: sandbox capability and approval policy are separate; Local Workspace and Task Worktree environments support safe parallel work and handoff; the built-in browser uses a separate persistent profile with site and sensitive-action approvals; and long-running tasks remain steerable without gaining broader permissions. This gives users a familiar Codex-class coding loop without making Candy depend on Codex or copying undisclosed implementation details.

## Consequences

Candy adds stricter provider-credential isolation, domestic-only MiniMax routing, one execution owner per task, and sequential mutations within a task. V1 has no approval-and-sandbox bypass, automated browser upload, Candy cloud execution, or execution after Candy exits. Auto Debug is a specialized long-running task built on the existing agent loop, not a second workflow engine.
