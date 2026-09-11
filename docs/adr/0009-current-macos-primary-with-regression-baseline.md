---
status: superseded
supersedes: ADR-0008
superseded_by: ADR-0012
---

# Use the current macOS host as primary and retain an explicit regression baseline

Candy's primary macOS acceptance environment is the current stable macOS Tahoe `26.x` release on Apple Silicon. The current primary host reports `26.6.1`; acceptance reports record the exact product version rather than treating a patch or minor update as a different product contract.

The exact macOS `26.5.2` Apple Silicon environment remains a separately named compatibility regression baseline. It is required when Candy makes an explicit `26.5.2` compatibility claim, but its unavailability must not prevent deterministic validation on the current primary host or current-host Personal Preview work.

## Consequences

- `npm run acceptance:macos` runs the primary current-host matrix for Tahoe `26.x` on arm64, accepting versions at or above `26.5.2` within macOS major `26` and recording the exact host version.
- `npm run acceptance:macos:baseline` runs the exact `26.5.2` regression matrix and writes `out/acceptance/macos/baseline-latest.md`, so it cannot overwrite current-host evidence in `latest.md`.
- A newer macOS version is not silently treated as proof of every older-version behavior. Native containment, terminal, Keychain, Electron, recovery, and provider evidence remain evidence from the exact host on which they ran.
- A future macOS major version requires an explicit support-policy update and a new primary compatibility review.
- Windows 11 x64 remains the separate cross-platform acceptance target.
