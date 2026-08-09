# Candy Sandbox Runner

This is the narrow Rust process boundary permitted by ADR-0005. It owns no
task, provider, credential, workspace-policy, approval, session, or UI logic.

The current binary intentionally returns `unsupported`: macOS containment,
Windows Job Object ownership, descendant cancellation, no-network enforcement,
packaging, and security review are still Gate G2 blockers. Candy must keep
Shell-enabled Auto unavailable until both native backends pass those checks.
