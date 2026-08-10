# Candy Sandbox Runner

This is the narrow Rust process boundary permitted by ADR-0005. It owns no
task, provider, credential, workspace-policy, approval, session, or UI logic.

The macOS binary now accepts the versioned JSONL `run` request, launches an
absolute executable through `/usr/bin/sandbox-exec`, denies network access,
clears the child environment, bounds output, and returns a typed completion
response. The TypeScript caller separately enforces selected-workspace
containment and provider-secret isolation.

This is a local macOS validator backend, not a completed G2 security review.
The current Seatbelt profile deliberately keeps the default filesystem policy
while the Candy path guard supplies workspace containment; a stronger
workspace-only profile, descendant cancellation evidence, packaging, and
security review remain open. Windows Job Object ownership is still unsupported.
Candy must keep shell-enabled Auto and Auto Debug unavailable until both native
backends pass those checks.
