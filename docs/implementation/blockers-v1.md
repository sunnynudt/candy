# Candy V1 Blocker Register

Updated: 2026-08-10

| ID                | Owner                                    | Status      | Blocks                                                     | Validation procedure                                                                                                                                                                                                                     |
| ----------------- | ---------------------------------------- | ----------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0-LIVE-DS        | Product owner + implementation agent     | Blocked     | Enabling DeepSeek labels and ACC-04 live evidence          | Run LIVE-DS-01 through LIVE-DS-04 with an approved test credential under `docs/testing/live-provider-credentials.md`.                                                                                                                    |
| G0-LIVE-MM        | Product owner + implementation agent     | Blocked     | Enabling MiniMax M3 and ACC-04 live evidence               | Confirm Token Plan entitlement and run LIVE-MM-01 through LIVE-MM-05 against `api.minimaxi.com`.                                                                                                                                         |
| G0-MAC            | Product owner                            | Blocked     | macOS claims and final cross-platform acceptance           | Run the required matrix on macOS Sequoia 15+ Apple Silicon and attach sanitized evidence.                                                                                                                                                |
| G1-PERSISTENCE    | Implementation agent                     | In progress | Final persistence acceptance                               | Local Node 22 import, two-connection fencing, WAL/restart recovery, schema migration, task-run metadata, and deterministic app-server command loop pass; run packaged app-server topology and macOS tests.                               |
| G2-SANDBOX        | Implementation agent + security reviewer | In progress | Shell-enabled Auto and Shell Auto Debug                    | Specify the v1 protocol, implement both native backends, and pass escape, no-network, descendant, cancellation, packaging, and security-review tests.                                                                                    |
| G3-BROWSER        | Implementation agent                     | Pending     | Automatic Browser takeover claim                           | Test packaged Electron input-origin behavior; use explicit Take Control if origin cannot be distinguished reliably.                                                                                                                      |
| SIGNING           | Product owner                            | Blocked     | Signed/notarized release evidence                          | Provide Windows signing and Apple signing/notarization identities only through approved platform tooling.                                                                                                                                |
| G0-DS-ADAPTER     | Implementation agent                     | Blocked     | Enabling DeepSeek V4 Flash/Pro and ACC-03/04 live evidence | Run the approved Pi-backed live matrix with an approved credential; this unattended run will not inspect or import credentials from another tool.                                                                                        |
| G0-MAC-RUNTIME    | Product owner                            | Blocked     | Runtime cross-platform claim                               | Run the Runtime proof and session-remap matrix on macOS Sequoia 15+ Apple Silicon.                                                                                                                                                       |
| G1-ELECTRON       | Implementation agent                     | In progress | Packaged Desktop acceptance                                | macOS arm64 local packaged Electron 43.2.0 + Node 22.23.2 child, JSONL round-trip, ad-hoc signature, and quit cleanup pass; verify Apple-signed Sequoia and Windows packages.                                      |
| G1-KEYRING        | Product owner + implementation agent     | In progress | ACC-02 OS credential acceptance                            | Adapter and Candy-owned service/account mapping pass a packaged Node 22 macOS Keychain fixture; verify Apple-signed package path, deletion, and Windows Credential Manager without exposing complete credentials. |
| G2-NATIVE         | Security reviewer + implementation agent | Blocked     | Shell-enabled Auto and shell-based Auto Debug              | Review and run the Rust runner protocol and both OS containment backends for escape, no-network, descendants, cancellation, packaging, and process ownership. Current helper intentionally reports `unsupported`.                        |
| G4-WORKTREE       | Implementation agent                     | In progress | Reviewed Apply Changes acceptance                          | Git fixture create/inspect/unlock/cleanup passes; run dirty target, changed base, binary/untracked files, conflicts, Apply transfer, and Windows path matrix.                                                                            |
| G5-PERSISTED-AUTO | Implementation agent                     | In progress | Long-running product acceptance                            | Bounded validator progress and stop metadata now persist; integrate explicit resume/crash interruption with the full Task Engine.                                                                                                        |

## 2026-08-10 Phase 2 checkpoint

- Q1 Pi public surface: Pass for the deterministic adapter seam. `@earendil-works/pi-coding-agent` root exports and documented `SessionManager` are used; no internal Pi import is used by Candy source.
- Q2 DeepSeek contract: Pass for the deterministic contract seam only. The approved domestic DeepSeek endpoint, request shape, SSE parser, abort signal, tool-capable request field, and lease release are covered by fixtures. Live provider behavior remains Blocked under G0-LIVE-DS and G0-DS-ADAPTER.
- Q3 Candy-owned session: Pass locally. `CandyPiSessionStore` stores under the injected Candy app-data root, persists through Pi's `SessionManager`, and reloads with a remapped cwd.
- Q4 forbidden sinks: Pass for deterministic coverage. Protocol/session fixtures reject secret-shaped values; the provider lease is released before response consumption and is not projected into Runtime observations. No credential was read or requested.
- Q5 two-platform fixture: Blocked for macOS evidence. Windows local deterministic checks pass; macOS Sequoia execution and live provider evidence are unavailable in this unattended environment.

## 2026-08-10 control-plane and persistence checkpoint

- Deterministic result: latest sequential run passes format, lint, typecheck, build, 37 tests, protocol stdio, TUI smoke and read-only task smoke, app-server JSONL smoke, Pi boundary, lifecycle policy, durable queued FIFO restoration, real Git worktree fixture, and native Rust `cargo check --locked` on Windows.
- Persistence: `node:sqlite` is now covered by a Candy-owned metadata store with schema version 2, WAL, full synchronization, a 2.5-second busy timeout, extension loading disabled, restart recovery, interruption recovery, revision-fenced transitions, and bounded task-run metadata. Packaged app-server and macOS topology tests remain open.
- Long-running/workspace seams: `TaskController` reloads through the metadata store; validator progress stores only bounded counters, stop reasons, and SHA-256 fingerprint hashes; Git worktree fixtures create, inspect, unlock, and clean a detached task worktree without force removal.
- Protocol: task create/run/pause/resume/cancel/approval command shapes and state events are versioned and secret-rejected; legacy snapshot fixtures remain compatible.
- Security: renderer contracts expose credential presence and write/delete operations only; provider values are not in renderer projections, protocol messages, app-server stdout, or child allowlisted environments. No provider credential was read or requested.
- Capability gates: shell remains `unsupported`; MiniMax remains disabled; browser is deterministic-only; actual Electron and OS credential-store implementations are not advertised.
- Cross-platform: Windows local/native toolchain evidence passes; checkpoint `75ab4453` Windows and macOS push CI passed. Real macOS Electron, Keychain, Browser, and native containment evidence remains blocked.

Blocked external resources do not stop independent implementation. They do prevent the affected capability or release claim from being marked Pass.

## 2026-08-10 interactive TUI checkpoint

- The interactive TUI now has a durable local task loop with platform-specific Candy app-data paths, FIFO dispatch, one active owner per task, active-task interruption on restart, streamed Pi observations, task listing, queued/active cancellation, and explicit quit cancellation.
- The injected deterministic TUI test and the 44-test local suite pass under Node `22.23.2`; no live credential was read or requested.
- The full interactive TUI remains short of ACC-03/05/06 acceptance until packaged restart, cross-client ownership/handoff, and real-provider evidence run on both target platforms.

## 2026-08-10 models, workspace transfer, and Desktop shell checkpoint

- Deterministic model gate: schema 3 and protocol carry an explicit model id; DeepSeek Flash remains the default, DeepSeek Pro remains a distinct selection, and MiniMax M3 is explicit. The Pi M3 fixture proved domestic URL construction and typed image content; no live MiniMax entitlement or credential was used.
- Workspace gate: argument-array Git execution, worktree association, dirty removal refusal, target base/clean/secret/path/symlink checks, tracked binary patching, untracked byte transfer, and index-preserving Apply Changes pass the Candy-owned fixture. Windows path/reparse-point and conflict matrix evidence remain open.
- Desktop gate: secure nonce-CSP task shell, model/profile selection, transcript, task controls, and changed-file projection are source-complete for the deterministic protocol. Packaged child Node 22, signed artifacts, app restart, and macOS/Windows UI evidence remain blocked.
- Long-running gate: distinct control stop reasons are now represented in the runner and persistence seam. Full task-engine validator integration, resume/crash fixtures, and native shell validator remain open.

## 2026-08-10 app-server, Pi AgentSession, and credential adapter checkpoint

- Deterministic checkpoint passed: format, lint, typecheck, 42 tests, protocol stdio, TUI smoke, task smoke, app-server JSONL smoke, boundary checks, exact Pi graph check, lifecycle policy, and native Rust protocol compile.
- The Pi-backed engine now uses only the documented `@earendil-works/pi-coding-agent` root SDK exports. Its `ModelRuntime` receives a temporary in-memory credential store derived from the public type, so no `@earendil-works/pi-*` internal import or credential file is used.
- DeepSeek and MiniMax HTTP contract fixtures assert approved hosts, SSE projection, lease release, and no fallback. These are deterministic seams only; G0-LIVE-DS, G0-DS-ADAPTER, G0-LIVE-MM, and entitlement blockers remain unchanged.
- The Desktop source now has a renderer-safe write-only credential bridge, typed app-server client, task event projection, Candy-owned browser partition, and explicit close-versus-quit path. Packaged runtime, signed artifact, Keychain/Credential Manager, Browser, and macOS evidence remain Blocked.
- No real provider credential was read, requested, imported, logged, stored, or placed in evidence. Fixture strings are test canaries only.

## 2026-08-10 attachment, process-supervision, and browser-boundary checkpoint

- The local deterministic checkpoint passes format, lint, typecheck, 53 tests, native Rust unit tests, and `npm run check:native`.
- Attachment storage and the typed app-server-to-Pi image handoff are implemented under Candy-owned app-data paths. This does not clear G0-LIVE-MM, G0-LIVE-DS, or the MiniMax Token Plan entitlement gate.
- The POSIX `ProcessSupervisor` is fail-closed around provider environment material and uses shell-free argument arrays. Windows Job Object ownership and macOS sandbox containment are still blocked under G2-SANDBOX/G2-NATIVE; Shell and Auto Debug remain `unsupported`.
- The native helper now rejects oversized or credential-shaped JSONL input, but still returns `unsupported` for every executable request. This is protocol hardening, not containment evidence.
- Electron Browser Workspace navigation, redirects, popups, permissions, and downloads are now denied by default; only a future explicit HTTPS host allowlist can permit navigation. Packaged Browser input-origin and adversarial fixture evidence remain blocked under G3-BROWSER.
- The app-server now forwards persisted attachment payloads through the Pi bridge and enforces the default three active-task slots with FIFO promotion. This is deterministic task-runtime evidence only; packaged cross-client ownership and restart handoff remain open.
- The deterministic app-server matrix also covers actionable provider errors, second-owner read-only behavior, and owned-task interruption on close. It does not clear the packaged TUI/Desktop handoff, native process, or dual-platform recovery gates.
- TUI pause/resume is implemented with explicit stop reasons and a recovery prompt seam. Full cross-process handoff, persisted transcript/diff UI, and restart evidence remain blocked by the packaged/runtime and platform gates.
- No real provider credential was read, requested, imported, logged, stored, or placed in evidence. Live-provider, OS keyring, signed packaging, macOS Sequoia Apple Silicon, Windows 11, security-review, and final ACC-01..12 gates remain open.

## 2026-08-10 local acceptance evidence package

- `docs/evidence/acceptance-v1-local-0710d00.md` is a sanitized local review package for revision `0710d004ec0ec7a40c0a1969f1b50800ef5a3277`.
- It deliberately reports ACC-01 through ACC-12 as Blocked or incomplete rather than converting deterministic seams into release passes. The package records the missing provider, entitlement, target-platform, native-security, signing, Browser, and product-owner evidence.

## 2026-08-10 macOS Apple Silicon Desktop checkpoint

- On macOS `26.5.2` arm64, which is a local Apple Silicon development result but not the required Sequoia 15 exact acceptance environment, Node `22.23.2`, Electron `43.2.0`, and the native helper build pass.
- `npm run smoke:desktop` starts Electron with an explicit development Node 22 app-server, completes a typed JSONL snapshot round-trip, and exits cleanly.
- `npm run smoke:desktop:packaged` builds `out/macos/Candy.app`, embeds Node `22.23.2`, runs the app-server from `resourcesPath`, verifies the ad-hoc signed bundle, completes the same JSONL smoke, and exits cleanly.
- The macOS Keychain fixture passes `absent -> present -> absent` for Candy's two credential accounts. This is not signed-package ACC-02 evidence and no provider credential was used.
- The packaged Node 22 runtime loads the bundled Keychain native addon and repeats the same two-account fixture through `npm run smoke:desktop:packaged`.
- The package is ad-hoc signed for local execution only. Apple Developer signing/notarization, Sequoia exact-machine evidence, live providers, Browser adversarial tests, and native containment remain open. Shell and Auto Debug remain `unsupported`.
