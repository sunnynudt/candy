---
status: accepted
supersedes: ADR-0012 (clause: "Candy V1 macOS acceptance targets the current stable Tahoe 26.x Apple Silicon host (currently 26.6.1)" and the code-level `major === 26` enforcement that implemented it)
---

# macOS acceptance uses a numeric floor, not a code-level major pin

## Context

ADR-0008 pinned acceptance to an exact macOS version (`26.5.2`). ADR-0009 relaxed that to a numeric floor ("at or above `26.5.2` within macOS major `26`") and retained an exact `26.5.2` regression baseline. ADR-0012 removed that baseline once the host upgraded to `26.6.1` and stated the target is "the current MacBook Pro macOS host", while keeping `26.x` as the acceptance gate in code.

The current implementation in `tests/acceptance-macos.mjs` enforces `major === 26` and rejects the runner with a blocked report when the host major is anything else. The intent (ADR-0009, lines 17-18) was governance: do not silently treat a newer host's evidence as proof of older-version behavior, and require an explicit support-policy update when the macOS major changes. The implementation conflates two concerns:

1. **Acceptance harness** — collect evidence on the host that is actually running.
2. **Support claim** — declare which macOS versions Candy V1 supports.

Hard-failing the harness on a newer major blocks the first concern whenever the second needs updating. It also makes the runner's name and behaviour version-coupled (`isTahoe26Version`), forcing a code edit per host bump.

## Decision

The macOS acceptance harness accepts any host that is `darwin`, `arm64`, and reports a macOS product version **at or above the documented floor** declared in `config/platform-support.mjs`. There is no upper bound: the harness records the exact version in every report and does not refuse to run on a newer host.

Support claims remain a contract matter. Raising the floor or adding a supported-major `default-last-hour` gate for the release pipeline is an ADR change, not a code edit to a version-coupled predicate.

## Consequences

- `config/platform-support.mjs` declares `macosMinimumVersion = { major: 26, minor: 5, patch: 2 }` and `macosArchitecture = "arm64"`. Raising the floor is a one-line data change plus an ADR.
- `tests/acceptance-macos.mjs` replaces `isTahoe26Version` with `meetsMinimumMacosVersion(value, floor)` and parses 1, 2, or 3 component macOS product versions.
- The blocked-report path remains in place for genuinely unsupported hosts (wrong platform, wrong architecture, below the floor). The reason text reads "macOS `X.Y.Z` or later on `arch`; received `value` on `arch`" so future maintainers see the floor, not a stale codename.
- Acceptance reports continue to record `- macOS product version: <value>` and `- Acceptance target: macOS <floor> or later on <arch>`. Evidence from a host newer than the floor is valid and labeled.
- The historical 26.x-specific evidence files, ADRs, and toolchain notes remain valid records and are not invalidated by this ADR. `docs/evidence/acceptance-v1-macos-34ec232.md` is bound to the `34ec232` revision on macOS `26.6.1`, not to "macOS 26.x generally".
- A future release gate may add an explicit "evidence must come from a supported-major set" check; this is out of scope here and would live behind an opt-in flag on the runner.
- Windows 11 x64 acceptance is unchanged and out of scope for this ADR.

## Superseded clause

ADR-0012's statement "Candy V1 macOS acceptance targets the current stable Tahoe `26.x` Apple Silicon host (currently `26.6.1`)" and the code-level `major === 26` enforcement that implemented it are superseded. The rest of ADR-0012 (single acceptance entry point, no separate baseline runner, evidence retention) remains in force.