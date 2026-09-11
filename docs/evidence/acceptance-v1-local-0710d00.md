# Candy V1 Local Acceptance Evidence

Status: Blocked; this package is a local review record, not a V1 release claim.

Generated: 2026-08-10

## Build identity

- Source revision: `0710d004ec0ec7a40c0a1969f1b50800ef5a3277`
- Branch: `codex/candy-v1-foundation`
- Lockfile SHA-256: `8f691d84dfe233379fb28367da3c1c182e2bf8859340440f90103986e6531828`
- Node: `22.23.2`
- npm: `10.9.8`
- TypeScript: `5.9.3`
- Pi package graph: seven `@earendil-works/pi-*` packages, all `0.84.1`
- Electron compatibility line: `43.2.0`
- Native toolchain: Cargo `1.97.1`

## Sanitized local checks

The following checks passed on the current workspace:

- `npm run check` — format, lint, typecheck, 53 tests, dependency boundaries, exact Pi graph, and lifecycle policy.
- `npm run smoke:tui` — Pi public export boundary, deterministic read-only turn, and Browser unavailable capability.
- `npm run smoke:tui-task` — durable task creation, owner transition, streamed observations, and completion.
- `npm run smoke:app-server` — typed JSONL app-server round trip.
- `npm run check:native` — Rust protocol helper compilation.
- `cargo fmt --manifest-path native/sandbox-runner/Cargo.toml -- --check`.
- `cargo test --manifest-path native/sandbox-runner/Cargo.toml --locked` — 3 tests.
- Staged secret scan — no credential-shaped material, external local paths, or provider values found.

No real provider credential, OS credential value, browser authentication data, private source, or external repository content is included in this package.

## Acceptance status

| Gate   | Status  | Local evidence and remaining blocker                                                                                                                                                                                                 |
| ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ACC-01 | Blocked | Toolchain and deterministic launch seams pass; packaged child runtime, signed artifacts, macOS Sequoia, and Windows 11 install evidence are unavailable.                                                                             |
| ACC-02 | Blocked | Write-only renderer bridge, Candy-owned temporary credential path, secret-free protocol/session/tool env tests pass; real Keychain and Credential Manager verification is unavailable.                                               |
| ACC-03 | Blocked | Pi public AgentSession, read-only tool/session seam, task ownership, FIFO, transcript event, and diff/workspace fixtures pass locally; live DeepSeek, mutable sandbox, validator, and two-platform journey evidence are unavailable. |
| ACC-04 | Blocked | DeepSeek/MiniMax deterministic domestic endpoint and image/no-fallback seams pass; live credentials, MiniMax Token Plan entitlement, and live matrix are unavailable.                                                                |
| ACC-05 | Blocked | Revision fencing, owner protection, interruption, and Candy-owned session seams pass; packaged TUI/Desktop handoff and cross-platform restart evidence are unavailable.                                                              |
| ACC-06 | Blocked | Three-slot app-server scheduling, FIFO promotion, and independent provider gate fixtures pass; dual-platform and full workspace concurrency evidence are unavailable.                                                                |
| ACC-07 | Blocked | Read-only approval and POSIX shell-free process seam fail closed; macOS containment, Windows Job Object, descendant cancellation, and security review are unavailable. Shell/Auto remains unsupported.                               |
| ACC-08 | Blocked | Git worktree, binary/untracked Apply Changes, dirty/base/path/secret guards pass in Candy-owned fixtures; Windows path/reparse/conflict matrix and reviewed cross-platform evidence are unavailable.                                 |
| ACC-09 | Blocked | Deterministic browser owner/revision/confirmation model and Electron default-deny navigation/permission/download boundary exist; packaged visible Browser Workspace and adversarial fixture evidence are unavailable.                |
| ACC-10 | Blocked | Validator-only completion, stall detection, bounded progress, distinct stop reasons, and TUI pause/resume pass deterministically; native shell validators and full Auto Debug Task Engine/UI integration are unavailable.            |
| ACC-11 | Blocked | SQLite WAL, migrations, owner interruption, revision fencing, attachment integrity, and bounded run metadata pass locally; packaged crash/recovery, upgrade, restore, and both-platform evidence are unavailable.                    |
| ACC-12 | Blocked | Cancellation and bounded local control seams are tested; required ten-run macOS/Windows timing matrix is unavailable.                                                                                                                |

## Open release blockers

- Approved temporary DeepSeek credential for LIVE-DS-01 through LIVE-DS-04.
- Approved MiniMax domestic Token Plan credential and entitlement for LIVE-MM-01 through LIVE-MM-05.
- macOS Sequoia 15+ Apple Silicon acceptance machine and runtime evidence.
- Windows 11 x64 acceptance machine and Job Object evidence.
- Security review and implementation of the macOS Sandbox Runner and Windows Job Object backends.
- Signed/notarized packaging identities and packaged app-server/restart evidence.
- Packaged Browser Workspace adversarial fixture and input-origin/Take Control evidence.
- Product-owner review and explicit approval of the completed evidence package.

These blockers prevent release classification as Pass. No capability behind them has been enabled or reported as accepted.
