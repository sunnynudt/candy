---
status: superseded by ADR-0008
---

# Require macOS Sequoia 15 or newer

Superseded on 2026-08-10 by [ADR-0008](0008-target-current-macos-26-5-2.md). This record is retained for decision history only.

Candy V1 supports macOS Sequoia 15 or newer rather than spending design and verification effort on older macOS releases. This lets the Desktop and native Platform adapters adopt current Electron and operating-system capabilities without carrying compatibility branches whose product value does not justify their cost.

## Consequences

macOS 13 and 14 are unsupported. Release and security verification target supported macOS 15 patch versions on Apple Silicon; additional architectures or older systems require a later explicit decision.
