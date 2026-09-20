---
status: accepted
---

# Allow one narrow native Sandbox Runner

Candy remains a TypeScript product and control plane, but V1 permits one audited Rust helper for operating-system command containment and Windows Job Object process ownership. No stable TypeScript/Node contract provides the required macOS and Windows capabilities, while approval and path checks cannot replace a strong sandbox; the helper therefore contains only native launch, containment, process-tree, and cancellation mechanics behind a versioned typed JSONL stdio protocol.

## Consequences

Model, task, approval, provider, workspace policy, session, Browser, and UI logic remain in TypeScript. The helper never receives provider credentials, prompts, sessions, or unrestricted inherited environments. Shell-enabled Auto and Shell-based Auto Debug remain disabled until both native backends pass escape, no-network, process inheritance, cancellation, packaging, and security review on the current macOS Tahoe `26.x` Apple Silicon host and Windows 11.
