# Candy V1 Windows 11 Pro x64 Acceptance Evidence

Status: Blocked; this package is a current Windows 11 review record, not a V1 release claim. Final V1 acceptance still requires signing, live Provider contracts, OS-level G2 containment, independent security review, macOS parity, and product-owner approval.

Generated: 2026-08-12

## Build identity

- Source revision: `8c6b0063f1e07ddb374f92bff264768f1e581c7c`
- Branch: `codex/candy-v1-foundation`
- Lockfile SHA-256: `8f691d84dfe233379fb28367da3c1c182e2bf8859340440f90103986e6531828`
- Platform: Windows 11 Pro x64 (build `26200`), host architecture `x64`
- Node: `22.23.2`; npm: `10.9.8`; TypeScript: `5.9.3`
- Pi package graph: seven `@earendil-works/pi-*` packages, all `0.84.1`
- Electron runtime: `43.2.0` verified local Windows x64 distribution
- Native toolchain: Rust/Cargo `1.97.1` with MSVC x64 toolchain
- Protocol version: `1`; SQLite task metadata schema: `10`

## Sanitized deterministic checks

All of the following passed on clean revision `8c6b006` (`Worktree clean at start: yes`):

- `npm run acceptance:windows`: 22/22 steps, including `check:toolchain`, `check` (101 tests), `check:native`, native Job Object smoke (workspace/reparse/missing-executable rejection, bounded output, descendant cancellation), Credential Manager lifecycle, TUI/app-server, recovery, long-running, attachment recovery, cross-client, concurrency, Desktop, packaged Desktop JSONL, packaged recovery, packaged handoff, packaged long-running approval/steering, packaged renderer credential isolation, packaged coding journey (create/stream/edit/validator/diff/Apply/reopened transcript), packaged Browser adversarial, packaged Credential Manager, and ten-run responsiveness.
- `cargo test --locked`: 3/3; `cargo fmt --check`: pass.
- Ten-run ACC-12 subset: TUI cold start p95 `856 ms` (target `<= 2000`), Desktop cold start p95 `1019 ms` (target `<= 5000`), Runtime-to-UI projection p95 `1 ms` (target `<= 200`), cancellation to process-tree termination p95 `11 ms` (target `<= 5000`), Browser Take Control p95 `2 ms` (target `<= 500`), three-task renderer frame gap p95 `17 ms` (target `<= 1000`) with `9/9/9=>9/9/9` and zero event loss across all ten runs.
- Staged secret scan before each checkpoint commit: no credential-shaped material, external local paths, or provider values found. Sanitized reports are `out/acceptance/windows/latest.md` and `out/acceptance/windows/responsiveness-latest.md` (gitignored).

No real provider credential, OS credential value, browser authentication data, private source, or external repository content is included in this package.

## Acceptance status

| Gate | Status | Current Windows evidence and remaining blocker |
| --- | --- | --- |
| ACC-01 | Partial/Blocked | Clean-install toolchain, exact Pi closure, Node/Electron/runtime assertions, packaged Desktop JSONL child, packaged app-server restart, and launch timing pass. Signed installation/upgrade evidence is Blocked: no approved code-signing identity is present on this host. |
| ACC-02 | Partial/Blocked | Write-only renderer bridge, Credential Manager synthetic lifecycle (`absent -> present -> present -> absent`), packaged Node/keyring lifecycle, packaged renderer credential isolation (complete value never observable), subprocess env assertion, and session/protocol secret-free fixtures pass. DeepSeek account mutation window, MiniMax `minimax-token-plan` credential, live approved-host request metadata, and signed Desktop deletion remain Blocked. |
| ACC-03 | Partial/Blocked | Deterministic packaged coding journey passes create/stream/edit/validator/diff review/Apply/reopened transcript with uncommitted changes and untouched index. Live DeepSeek V4 Flash journey through the real Pi Adapter remains Blocked (credential/live matrix). |
| ACC-04 | Partial/Blocked | Domestic MiniMax deterministic endpoint/no-fallback fixtures and M3 image turn seam pass; MiniMax Token Plan entitlement confirmed but the Candy-owned credential is absent, so LIVE-MM-01..05 remain Blocked (0 ms, no network request). DeepSeek Flash/Pro selection seams pass; live contract IDs remain Blocked. |
| ACC-05 | Partial/Blocked | Revision fencing, owner protection, packaged sequential cross-client handoff, attachment restart recovery, and reopened transcript persistence pass. Packaged TUI/Desktop same-session journey across both platforms and full cross-platform restart matrix remain open. |
| ACC-06 | Pass (deterministic subset) | Three active slots, FIFO promotion/reorder, four-task Windows concurrency smoke, worktree separation fixtures, and DeepSeek-provider-error isolation from concurrent MiniMax/local reads pass (108 tests). Real cross-provider concurrency under live rate limits and the full dual-platform matrix remain open. |
| ACC-07 | Partial/Blocked | Job Object ownership, descendant cancellation, workspace/reparse/missing-executable rejection, bounded output, and pre-resume launch TOCTOU revalidation pass. OS-level no-network containment for arbitrary commands, post-resume runtime reparse/race prevention, and independent security review remain Blocked; Shell Auto and Shell Auto Debug stay disabled. |
| ACC-08 | Partial/Blocked | Git worktree create/apply/discard/restart fixtures, binary/untracked Apply, dirty/changed-base/conflict guards, Windows path/reparse fixtures, packaged coding-journey Apply (uncommitted, index untouched), and non-Git added/changed/removed review (107 tests) pass. Non-Git Apply remains review-only (no patch contract); full conflict/binary/recovery matrix and both-platform review remain open. |
| ACC-09 | Partial/Blocked | Packaged Windows Browser allowlist, revision fencing, typed actions, screenshot attachment id, default-deny navigation/popup/permission, visible download state with single-confirm Candy-owned downloads directory (sanitized filename, no auto-open, no model/session/protocol ingress), prompt-injection inertness, navigation race, Take Control conflict rejection, and page-marker isolation pass. Reliable physical input-origin detection remains Blocked; explicit Take Control fallback remains the accepted transfer. |
| ACC-10 | Partial/Blocked | Packaged approval wait/steering/validator-only completion/final evidence projection, distinct stop reasons, bounded progress, crash interruption, and user cancellation with descendant cleanup pass. Real-Provider stream-stop latency, native shell validator, OS containment, and signed-package evidence remain Blocked. |
| ACC-11 | Partial/Blocked | SQLite WAL/schema v10 migration, transcript persistence across restart, owner interruption/revision fencing, attachment recovery, packaged Node/app-server recovery, app-server child restart race fix, unknown-future-schema rejection (handle closed before throw), corrupted-database fail-closed, file-level backup/restore, and storage-open failure fail-closed fixtures pass (105 tests). Upgrade/rollback (signed package), real full-disk, and task/attachment deletion policy fixtures remain open/Blocked where product scope or environment requires them. |
| ACC-12 | Partial/Blocked | Ten-run deterministic metrics pass for cold start, Runtime-to-UI projection, cancellation to process-tree termination, Browser Take Control, and three-task frame gap/event delivery. User cancellation to provider stream stop request and provider first-token latency remain Blocked because no real Provider stream is used. |

## Open release blockers

- Windows code-signing identity (approved certificate with Code Signing EKU, PFX, or Trusted Signing) for `package:desktop:windows:release` and the install/upgrade/rollback/uninstall verifier.
- Candy-owned MiniMax `minimax-token-plan` credential for `npm run gate:live:minimax` (LIVE-MM-01..05).
- User-authorized DeepSeek account mutation window for the existing Candy `deepseek` Credential Manager account.
- OS-level no-network and arbitrary-command workspace containment, post-resume reparse/race protection, packaged/signed runner evidence, and independent security review (G2). This session runs at Medium integrity without `SeCreateAppContainerPrivilege`; `New-AppContainerProfile` fails and WFP filters require elevation, so AppContainer/WFP containment cannot be implemented or verified without an elevated environment or an external security reviewer.
- Reliable Browser physical input-origin detection; explicit Take Control remains the accepted fallback.
- macOS `26.5.2` Apple Silicon parity and Apple signing/notarization for the cross-platform release claim.
- Product-owner review and explicit approval of the completed evidence package.

These blockers prevent release classification as Pass. No capability behind them has been enabled or reported as accepted.
