---
status: accepted
supersedes: ADR-0007
---

# Target the current macOS 26.5.2 Apple Silicon acceptance machine

Candy V1 macOS acceptance targets the current local machine baseline: macOS `26.5.2` on Apple Silicon. This replaces the former generic macOS Sequoia 15+ acceptance predicate.

## Consequences

- macOS evidence must record and run on `26.5.2` and `arm64`; a different macOS version is not silently accepted by the local macOS acceptance runner.
- This is a concrete V1 acceptance target, not a compatibility promise for every earlier, later, Intel, or generic Sequoia release.
- The macOS requirements for signed packaging, Keychain behavior, native containment, Browser security, recovery, and Provider Gates are unchanged.
- Windows 11 x64 remains the separate V1 cross-platform acceptance target.
