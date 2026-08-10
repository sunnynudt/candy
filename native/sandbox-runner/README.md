# Candy Sandbox Runner

This is the narrow Rust process boundary permitted by ADR-0005. It owns no
task, provider, credential, workspace-policy, approval, session, or UI logic.

The macOS binary accepts the versioned JSONL `run` request, launches an
absolute executable through `/usr/bin/sandbox-exec`, denies network access,
clears the child environment, bounds output, and returns a typed completion
response. On Windows, the same protocol launches a suspended absolute
executable, assigns it to a Job Object before resume, enables
`KILL_ON_JOB_CLOSE`, bounds output, rejects workspace/cwd reparse paths, and
cleans up the owned process tree. The TypeScript caller separately enforces
selected-workspace containment and provider-secret isolation.

This is not a completed G2 security review. The current macOS Seatbelt profile
deliberately keeps the default filesystem policy while the Candy path guard
supplies workspace containment. The Windows Job Object backend proves process
ownership and cancellation, but protocol `network: false` is not OS network
isolation and the native preflight does not prevent a command from creating a
reparse point after launch. Stronger workspace containment, packaging, and
security review remain open. Candy must keep shell-enabled Auto and Auto Debug
unavailable until both native backends pass those checks.
