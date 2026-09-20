# Candy V1 Windows 11 Pro x64 Acceptance Evidence

Status: Blocked; this is the current Windows deterministic and packaged-development evidence package, not a V1 release claim. Final V1 acceptance still requires signed installation, live Provider contracts, OS-level G2 containment, independent security review, macOS parity, and product-owner approval.

Generated: 2026-08-12

## Build identity

- Source revision: `b7cab12a8ecfd18d46c2813653e19dd978143ee4`
- Branch: `codex/candy-v1-foundation`
- Lockfile SHA-256: `929848f85b3b11cc362c727848c8a2319d9771d9ff4780044a9333b829c57944`
- Platform: Windows 11 Pro x64, ordinary non-Administrator session
- Node: `22.23.2`; npm: `10.9.8`; TypeScript: `5.9.3`
- Pi package graph: seven `@earendil-works/pi-*` packages, all `0.84.1`
- Electron runtime: `43.2.0` verified local Windows x64 distribution
- Native toolchain: Rust/Cargo Windows MSVC x64 toolchain
- Protocol version: `1`; SQLite task metadata schema: `10`

## Sanitized deterministic checks

`npm run acceptance:windows` passed 22/22 steps from a clean worktree at this revision:

- `check:toolchain`, `check` (126 tests), `check:native`, and Windows Job Object smoke;
- Credential Manager synthetic lifecycle, TUI task, app-server JSONL, recovery, long-running cancellation, attachment recovery, cross-client fencing, and three-slot concurrency;
- Desktop JSONL, unsigned packaged Desktop, packaged recovery, sequential packaged handoff, packaged approval/steering, packaged renderer credential isolation, and packaged coding journey/transcript recovery;
- packaged Browser authorization/action/adversarial security fixture and packaged Credential Manager fixture;
- ten-run Windows responsiveness measurement.

The ten-run deterministic subset passed with TUI/Desktop cold-start p95 `905/1370 ms`, Runtime-to-UI projection p95 `1 ms`, cancellation to task-owned process-tree termination p95 `12 ms`, Browser Take Control p95 `1 ms`, and three-task renderer frame-gap p95 `17 ms`; all ten concurrency runs delivered `9/9/9=>9/9/9` with zero event loss.

Sanitized reports are `out/acceptance/windows/latest.md` and `out/acceptance/windows/responsiveness-latest.md`; both are gitignored. The packaged Windows bundle was explicitly unsigned and used only the verified local Electron runtime through the acceptance runner's override.

## Security and evidence boundary

- The Pi isolation fixture uses a real directory junction on ordinary Windows sessions. The file-symlink `AGENTS.md` contract uses Candy's injectable filesystem seam and remains fail-closed; real file-symlink and broader reparse/race matrices still require Developer Mode or equivalent authorization.
- Native runner path resolution now validates explicit absolute overrides before module URL decoding and uses target-platform Windows/POSIX path semantics. Relative and missing overrides remain fail-closed.
- No real provider credential, OS credential value, browser authentication data, private source, external repository content, session upload, or public provider request was used. Fixture canaries are test-only values.

## Open release blockers

- Windows signed installation, upgrade, rollback, and uninstall evidence.
- Full lifecycle mutation evidence for the already-present Candy DeepSeek Credential Manager account; the empty synthetic MiniMax account was used for the deterministic fixture.
- OS-level no-network and arbitrary-command workspace containment, runtime reparse/race prevention, packaged/signed runner evidence, and independent security review; Shell Auto and Shell Auto Debug remain disabled.
- Reliable Browser physical input-origin detection, broader hostile-page coverage, and complete Browser/ACC-09/ACC-12 evidence.
- Live MiniMax/Token Plan entitlement evidence, remaining ACC-01..12 journeys, macOS `26.5.2` parity, Apple signing/notarization, and product-owner acceptance.

These blockers prevent release classification as Pass. The 22/22 deterministic result must not be reported as complete V1 acceptance.
