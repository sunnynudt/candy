# Candy V1 Blocker Register

Updated: 2026-08-11

| ID                | Owner                                    | Status      | Blocks                                                     | Validation procedure                                                                                                                                                                                              |
| ----------------- | ---------------------------------------- | ----------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0-LIVE-DS        | Product owner + implementation agent     | In progress | Cross-platform DeepSeek live evidence                      | Windows 11 Gate passed 7/7 on 2026-08-10: `LIVE-DS-01..04`, cancellation, controlled 401/429/timeout, secret-free session scan, and secret-lease release. Repeat the same matrix on macOS before a cross-platform claim. |
| G0-LIVE-MM        | Product owner + implementation agent     | Blocked     | Enabling MiniMax M3 and ACC-04 live evidence               | Confirm Token Plan entitlement and run LIVE-MM-01 through LIVE-MM-05 against `api.minimaxi.com`.                                                                                                                  |
| G0-MAC            | Product owner                            | In progress | Complete macOS acceptance                                  | The 2026-08-11 macOS runner passes 9/9 deterministic/native/TUI/app-server/Electron/package steps with 94 tests on macOS `26.5.2` arm64; the sanitized report is `out/acceptance/macos/latest.md`. Continue with Runtime/session-remap, ACC-12 ten-run responsiveness, full recovery/Browser matrix, live-provider, signing, and native-security evidence. |
| G0-WIN            | Product owner + implementation agent     | In progress | Windows and cross-platform V1 release claims               | On clean revision `7c2eb877b0a9262735623aa83016916bf0fcc997`, the Windows 11 Pro x64 deterministic runner passes 19/19, including user-cancelled long-running validator cleanup, active validator interruption, queued/active process-restart recovery, attachment restart recovery, non-owner read-only fencing, bounded three-slot concurrency, unsigned packaged Desktop JSONL smoke, packaged active-owner/tool recovery, packaged sequential cross-client handoff, extended packaged Browser action/adversarial security fixture smoke including hostile-selector rejection, and packaged Credential Manager fixture smoke. The latest cold-start subset is TUI p95 `1185 ms` and Desktop p95 `1432 ms`; continue the dedicated checklist for signed installation, complete Browser physical-input/coverage, complete G2, remaining ACC metrics, and external provider/signing gates. |
| G1-PERSISTENCE    | Implementation agent                     | In progress | Final persistence acceptance                               | Local Node 22 import, two-connection fencing, WAL/restart recovery, schema migration, task-run metadata, deterministic app-server command loop, and unsigned packaged Windows app-server JSONL smoke pass; run signed/package topology and macOS tests. |
| G2-SANDBOX        | Implementation agent + security reviewer | In progress | Shell-enabled Auto and Shell Auto Debug                    | Windows native runner now has Job Object ownership, suspended assignment, descendant cleanup, protocol network rejection, workspace/cwd canonical and reparse preflight, and a local cancellation smoke. OS-level no-network/workspace containment, runtime race prevention, packaging, and security review remain open; macOS stronger containment also remains open. |
| G3-BROWSER        | Implementation agent                     | In progress | Browser Workspace and automatic takeover claim              | Packaged Windows WebContentsView fixture now proves explicit site allow, observation, structured click/type/confirmed-submit, stale/user-owner rejection, screenshot attachment ids, URL/action/selector target rejection, redirect/popup/permission/download default-deny, and Take Control fallback. Complete adversarial page matrix and input-origin evidence; use explicit Take Control because reliable physical-origin detection is not claimed. |
| SIGNING           | Product owner                            | Blocked     | Signed/notarized release evidence                          | Provide Windows signing and Apple signing/notarization identities only through approved platform tooling.                                                                                                         |
| G0-DS-ADAPTER     | Implementation agent                     | In progress | Cross-platform DeepSeek V4 Flash/Pro and ACC-03/04 evidence | The Windows Pi-backed Gate passed 7/7 on 2026-08-10; repeat it on macOS and complete the remaining platform acceptance evidence. No unattended run may inspect or import another tool's credentials.               |
| G0-MAC-RUNTIME    | Product owner                            | In progress | Runtime cross-platform claim                               | Run the Runtime proof and session-remap matrix on macOS `26.5.2` Apple Silicon.                                                                                                                                   |
| G1-ELECTRON       | Implementation agent                     | In progress | Packaged Desktop acceptance                                | macOS `26.5.2` arm64 local packaged Electron 43.2.0 + Node 22.23.2 child, JSONL round-trip, ad-hoc signature, and quit cleanup pass; Windows x64 unsigned Electron 43.2.0 + Node 22.23.2 + native runner package and JSONL smoke pass. Verify Apple/Windows signed installation and recovery. |
| G1-KEYRING        | Product owner + implementation agent     | In progress | ACC-02 OS credential acceptance                            | Candy-owned service/account mapping, Windows Credential Manager synthetic lifecycle, and the bundled packaged Node/keyring lifecycle (`absent -> present -> present -> absent`) pass; mutate the existing DeepSeek account only under a controlled user-authorized window and verify signed Desktop deletion without exposing complete credentials. |
| G2-NATIVE         | Security reviewer + implementation agent | In progress | Shell-enabled Auto and shell-based Auto Debug              | Windows 11 native smoke proves Job Object process ownership, complete descendant cancellation on runner close, protocol network rejection, workspace escape rejection, and junction reparse rejection. It does not prove OS-level no-network or arbitrary-command workspace isolation; packaging and independent security review remain open, as does stronger macOS containment. |
| G4-WORKTREE       | Implementation agent                     | In progress | Reviewed Apply Changes acceptance                          | Desktop Apply runs through a real Task Worktree handoff with persisted association, explicit discard, and patch-truncation/manifest-change guards; macOS `/var` to `/private/var` canonical association, cross-host Windows path-seam fixtures, dirty target, changed base, conflict, untracked collision, real Windows Git worktree/Apply/restart fixtures, and junction escape rejection pass. Broader platform matrices, Windows reparse-point evidence, and security review remain under G0-WIN/G2. |
| G5-PERSISTED-AUTO | Implementation agent                     | In progress | Long-running product acceptance                            | Auto tasks now alternate bounded normal turns and the same validator, persist run progress/stop reasons, expose Desktop progress, mark restart uncertainty as `crash_interrupted`, and pass a Windows `task.cancel` descendant-cleanup smoke; complete user steering/approval integration, final evidence summary, native shell validator, and packaged/platform evidence. |

## Daily platform handoff boundary

- **MacBook Pro daytime:** implement and verify macOS `26.5.2` Apple Silicon only. The macOS Git Task Worktree canonical-path repair is complete; the next active queue is Runtime/session-remap and then the remaining macOS-only deterministic evidence. Windows-only code and validation do not belong in this session.
- **Windows 11 PC evening:** implement and verify Windows-only code, reparse-point, Job Object, packaged Windows, Credential Manager, Browser, and Windows responsiveness work. macOS results must not be copied into those gates.
- Shared TypeScript changes may be authored on macOS when they are needed for the macOS slice, but Windows acceptance remains deferred until the Windows handoff.

## Windows 11 night handoff list (deferred from macOS sessions)

Windows work now continues on the current Windows 11 Pro x64 host. The passing deterministic worktree and junction checks are an implementation checkpoint, not acceptance evidence: GitHub-hosted CI and local fixtures do not substitute for the complete Windows 11 x64 matrix.

Complete and attach sanitized evidence for:

- TUI and signed Desktop installation, packaged Node app-server lifecycle, and the remaining full ACC-12 responsiveness matrix. The unsigned Windows package and extended Browser action/security fixture now pass their deterministic subset; queued/active owner crash recovery, attachment restart recovery, active validator interruption, user cancellation with descendant cleanup, non-owner cross-client fencing, bounded three-slot concurrency, packaged active-owner/tool recovery, and packaged sequential cross-client handoff pass; the latest clean-revision ten-run subset has TUI p95 `1173 ms` and Desktop p95 `1396 ms`; Browser physical input-origin/complete adversarial coverage, renderer concurrency, and signed installation evidence remain open.
- Credential Manager presence/set/replace/delete behavior without renderer credential readback. The 2026-08-11 Windows synthetic fixture covers the empty MiniMax account, and the packaged Node/keyring fixture repeats it; the existing DeepSeek account was presence-only and untouched.
- Sandbox Runner Job Object ownership, descendant cancellation, OS-level no-network containment, and security review. The 2026-08-11 smoke proves only protocol-level network rejection, not OS network isolation.
- Browser Workspace packaged action, screenshot attachment, input-origin, Take Control, permission, redirect, download, and adversarial tests. The packaged Windows fixture now passes structured click/type/confirmed-submit, NUL/invalid-selector and other URL/action/selector target rejection, stale/user-owner rejection, screenshot id handoff, default-deny, and explicit Take Control; physical input-origin detection and the complete adversarial page matrix remain open.
- Worktree and Apply Changes path, reparse-point, conflict, binary, untracked-file, and recovery matrices.
- Task/session/attachment recovery, cross-client ownership, restart, and cancellation behavior. Queued metadata, attachment restart recovery, active validator interruption, user cancellation with descendant cleanup, active-owner crash-interruption process-restart, non-owner read-only fencing, packaged active-owner/tool interruption, and packaged sequential cross-client handoff now pass; complete Desktop recovery and the full ACC-05 matrix remain open.
- The Windows portions of ACC-01 through ACC-12, including Windows signing evidence.

## 2026-08-10 Windows 11 deterministic worktree checkpoint

- A clean `npm ci --ignore-scripts` followed by `npm run check` passes on the Windows 11 Pro x64 host: format, lint, typecheck, 88 tests, protocol/boundary checks, exact Pi closure, and lifecycle policy. `smoke:tui-task` and `smoke:app-server` also pass under Node `22.23.2`.
- Worktree association now uses structured NUL porcelain parsing with canonical path and exact lock-reason comparison. The real Git Task Worktree create, Apply, discard, and restart-handoff fixtures pass on Windows.
- The workspace escape fixture now uses a Windows directory junction and proves the Pi workspace boundary rejects it without requiring file-symlink privileges.
- G0-WIN and G4 remain In progress. The Windows cold-start responsiveness subset is evidence only for two ACC-12 metrics; this does not provide OS-level Windows native containment, packaged Desktop/Keyring, signing, Browser, live-provider, recovery, or the complete responsiveness matrix.

## 2026-08-10 durable queued-task reorder checkpoint

- The SQLite queue now atomically moves a queued task before another queued task and retains the resulting order across reopen. Protocol v1 and the app-server accept `task.reorder` only for pending queued run requests; a five-task fixture proves the reordered task receives the next available slot.
- The TUI provides `:prioritize <task-id>` and shows durable queue positions with `:tasks`. The current Desktop shell lacks a task-list/queue panel, so Desktop reordering UX remains an implementation task rather than a hidden capability claim.
- The Windows 11 Pro x64 deterministic gate passes with 92 tests. G0-WIN remains In progress because full restart, cross-client, provider-rate-limit, packaged Desktop, and acceptance evidence are still incomplete.

## 2026-08-10 Phase 2 checkpoint

- Q1 Pi public surface: Pass for the deterministic adapter seam. `@earendil-works/pi-coding-agent` root exports and documented `SessionManager` are used; no internal Pi import is used by Candy source.
- Q2 DeepSeek contract: Pass for the deterministic contract seam only. The approved domestic DeepSeek endpoint, request shape, SSE parser, abort signal, tool-capable request field, and lease release are covered by fixtures. Live provider behavior remains Blocked under G0-LIVE-DS and G0-DS-ADAPTER.
- Q3 Candy-owned session: Pass locally. `CandyPiSessionStore` stores under the injected Candy app-data root, persists through Pi's `SessionManager`, and reloads with a remapped cwd.
- Q4 forbidden sinks: Pass for deterministic coverage. Protocol/session fixtures reject secret-shaped values; the provider lease is released before response consumption and is not projected into Runtime observations. No credential was read or requested.
- Q5 two-platform fixture: In progress. Windows local deterministic checks pass; macOS `26.5.2` deterministic and packaged smoke pass. Live-provider, recovery, native containment, and complete acceptance evidence remain open.

## 2026-08-10 control-plane and persistence checkpoint

- Deterministic result: latest sequential run passes format, lint, typecheck, build, 37 tests, protocol stdio, TUI smoke and read-only task smoke, app-server JSONL smoke, Pi boundary, lifecycle policy, durable queued FIFO restoration, real Git worktree fixture, and native Rust `cargo check --locked` on Windows.
- Persistence: `node:sqlite` is now covered by a Candy-owned metadata store with schema version 2, WAL, full synchronization, a 2.5-second busy timeout, extension loading disabled, restart recovery, interruption recovery, revision-fenced transitions, and bounded task-run metadata. Packaged app-server and macOS topology tests remain open.
- Long-running/workspace seams: `TaskController` reloads through the metadata store; validator progress stores only bounded counters, stop reasons, and SHA-256 fingerprint hashes; Git worktree fixtures create, inspect, unlock, and clean a detached task worktree without force removal.
- Protocol: task create/run/pause/resume/cancel/approval command shapes and state events are versioned and secret-rejected; legacy snapshot fixtures remain compatible.
- Security: renderer contracts expose credential presence and write/delete operations only; provider values are not in renderer projections, protocol messages, app-server stdout, or child allowlisted environments. No provider credential was read or requested.
- Capability gates: shell remains `unsupported`; MiniMax remains disabled; browser is deterministic-only; actual Electron and OS credential-store implementations are not advertised.
- Cross-platform: Windows local/native toolchain evidence passes; checkpoint `75ab4453` Windows and macOS push CI passed. Real macOS Electron, Keychain, Browser, and native containment evidence remains blocked.

Blocked external resources do not stop independent implementation. They do prevent the affected capability or release claim from being marked Pass.

## 2026-08-10 explicit local credential-import and live DeepSeek checkpoint

- The development-only OpenCode importer is opt-in, accepts only a user-specified `auth.json` inside an OpenCode directory, selects only the `deepseek` API entry, and writes directly to Candy's `candy-v1/deepseek` Keychain account. It does not enable automatic runtime synchronization.
- The real Pi-backed DeepSeek run reported 6 passed and 1 blocked. The cancellation, secret-free session, and secret lease checks passed; the controlled 401/429/timeout error-contract scenario remains blocked. `G0-LIVE-DS` and `G0-DS-ADAPTER` therefore remain Blocked.

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
- Electron Browser Workspace navigation, redirects, popups, permissions, and downloads are now denied by default; only a future explicit HTTPS host allowlist can permit navigation. Packaged Browser input-origin and complete adversarial page evidence remain blocked under G3-BROWSER; the URL/action/selector rejection subset passes.
- The app-server now forwards persisted attachment payloads through the Pi bridge and enforces the default three active-task slots with FIFO promotion. This is deterministic task-runtime evidence only; packaged cross-client ownership and restart handoff remain open.
- The deterministic app-server matrix also covers actionable provider errors, second-owner read-only behavior, and owned-task interruption on close. It does not clear the packaged TUI/Desktop handoff, native process, or dual-platform recovery gates.
- TUI pause/resume is implemented with explicit stop reasons and a recovery prompt seam. Full cross-process handoff, persisted transcript/diff UI, and restart evidence remain blocked by the packaged/runtime and platform gates.
- No real provider credential was read, requested, imported, logged, stored, or placed in evidence. Live-provider, complete macOS `26.5.2` acceptance, OS keyring, signed packaging, Windows 11, security-review, and final ACC-01..12 gates remain open.

## 2026-08-10 local acceptance evidence package

- `docs/evidence/acceptance-v1-local-0710d00.md` is a sanitized local review package for revision `0710d004ec0ec7a40c0a1969f1b50800ef5a3277`.
- It deliberately reports ACC-01 through ACC-12 as Blocked or incomplete rather than converting deterministic seams into release passes. The package records the missing provider, entitlement, target-platform, native-security, signing, Browser, and product-owner evidence.

## 2026-08-10 macOS Apple Silicon Desktop checkpoint

- On macOS `26.5.2` arm64, the accepted macOS baseline under ADR-0008, Node `22.23.2`, Electron `43.2.0`, and the native helper build pass. This smoke remains a subset of the full macOS acceptance matrix.
- `npm run smoke:desktop` starts Electron with an explicit development Node 22 app-server, completes a typed JSONL snapshot round-trip, and exits cleanly.
- `npm run smoke:desktop:packaged` builds `out/macos/Candy.app`, embeds Node `22.23.2`, runs the app-server from `resourcesPath`, verifies the ad-hoc signed bundle, completes the same JSONL smoke, and exits cleanly.
- The macOS Keychain fixture passes `absent -> present -> absent` for Candy's two credential accounts. This is not signed-package ACC-02 evidence and no provider credential was used.
- The packaged Node 22 runtime loads the bundled Keychain native addon and repeats the same two-account fixture through `npm run smoke:desktop:packaged`.
- The package is ad-hoc signed for local execution only. Apple Developer signing/notarization, live providers, Browser adversarial tests, native containment, and the remaining macOS `26.5.2` matrix remain open. Shell and Auto Debug remain `unsupported`.

## 2026-08-10 macOS acceptance runner checkpoint

- `npm run acceptance:macos` now provides one serial, explicit local macOS arm64 evidence run. It passed `check:toolchain`, `check`, `check:native`, TUI, app-server, Electron, packaged Desktop, and packaged Keychain smoke on the current machine.
- The runner writes only sanitized, ignored reports under `out/acceptance/macos/` and uses a minimal child environment. It does not read or import credentials and does not execute live provider tests.
- External blockers are unchanged except for the macOS version baseline: the remaining macOS work is the required `26.5.2` matrix, plus live DeepSeek/MiniMax matrices and entitlement, Apple signing/notarization, Browser adversarial evidence, native containment security review, and final product-owner acceptance.

## 2026-08-10 provider-chain checkpoint

- Provider Gate commands now exist but are opt-in and fail closed. The no-credential DeepSeek invocation produced a sanitized `Blocked` report and did not contact the provider.
- Pi thinking deltas now have a typed adapter/runtime/protocol path. This improves the observable chain but does not itself prove live DeepSeek reasoning replay or MiniMax interleaved thinking.
- `G0-LIVE-DS`, `G0-LIVE-MM`, and `G0-DS-ADAPTER` remain `Blocked` until approved credentials, live runs, controlled 401/429/timeout/limit evidence, MiniMax Token Plan console confirmation, and required platform evidence are available.

## 2026-08-10 workspace diff projection checkpoint

- The app-server now captures a Git HEAD baseline at task creation and emits a versioned `workspace.changes` event after the Pi turn. Desktop renders the actual changed-file list and patch, including tracked and untracked paths; the protocol rejects escaping paths.
- The change path redacts active provider secrets before the event boundary. Deterministic verification passes format, lint, typecheck, 63 tests, boundary/version/lifecycle checks, native check, app-server JSONL smoke, safe-edit smoke, and Desktop smoke under Node `22.23.2`.
- G4 remains `In progress`: Desktop Apply Changes, persisted baseline/restart recovery, dirty/base/conflict and Windows matrices are not implemented or accepted. No live-provider or final-release gate changes.
