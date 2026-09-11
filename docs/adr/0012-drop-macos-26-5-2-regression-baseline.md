---
status: accepted
supersedes: ADR-0009
---

# Drop the exact macOS 26.5.2 regression baseline from V1

The MacBook Pro acceptance host has been upgraded from macOS `26.5.2` to the current Tahoe `26.6.1`, and the exact `26.5.2` environment is no longer available on the machine Candy actually runs on. The pre-upgrade system is not a required V1 target, so the exact `26.5.2` compatibility regression baseline defined by ADR-0009 is removed from the V1 scope. Candy V1 macOS acceptance targets the current stable Tahoe `26.x` Apple Silicon host (currently `26.6.1`).

## Consequences

- `npm run acceptance:macos` is the only macOS acceptance entry point; it targets the current Tahoe `26.x` Apple Silicon host and records the exact product version. The `--baseline` runner mode and the `npm run acceptance:macos:baseline` script are removed.
- No `26.5.2`-specific regression evidence is required or claimed for V1; Candy TUI only needs to run on the current MacBook Pro macOS host.
- A future macOS major version still requires an explicit support-policy update and a new primary compatibility review (unchanged from ADR-0009).
- Windows 11 x64 remains the separate cross-platform acceptance target.
- Historical checkpoints that recorded `26.5.2` preflight or regression results remain evidence records; they are not V1 gates.
