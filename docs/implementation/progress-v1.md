# Candy V1 Implementation Progress

Updated: 2026-08-10

| Phase                       | Status      | Evidence                                                                                                                                                                                                                                                                                                                             | Remaining                                                                                              |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 0. Compatibility Gate       | In progress | Accepted architecture and conditional Gate reports                                                                                                                                                                                                                                                                                   | Live credentials, macOS `26.5.2` matrix, native/security verification                                  |
| 1. Repository foundation    | Pass        | Phase 1 and later checkpoint CI pass on Windows and macOS `26.5.2` ARM; Pi closure is 7 packages at `0.84.1`; lockfile is stable                                                                                                                                                                                                     | None in deterministic local scope                                                                      |
| 2. Runtime proof            | Blocked     | Pi public `AgentSession` path now runs with a temporary in-memory credential store, read-only Pi tool allowlist, streamed deltas, Candy-owned session JSONL, and secret-free session assertion; DeepSeek HTTP seam remains covered                                                                                                   | Live DeepSeek contract and macOS Runtime evidence                                                      |
| 3. Task Runtime and TUI     | In progress | Task lifecycle, revision fencing, FIFO scheduler, durable queued FIFO restoration, leases, approval profiles, read-only runtime, mutation serialization, SQLite metadata, TaskController recovery, interactive TUI prompt/task/cancel loop, model persistence, and durable app-server create/run/pause/resume/cancel event loop pass | Full interactive TUI and process-restart ownership/cancellation matrix                                 |
| 4. Models and attachments   | Blocked     | Code-owned DeepSeek Flash/Pro and domestic MiniMax catalog, Pi-backed MiniMax M3 image turn, deterministic DeepSeek/MiniMax streaming seams, hashed image store, video-disabled behavior, and no-fallback policy pass deterministic tests                                                                                            | Live provider contracts and MiniMax entitlement                                                        |
| 5. Desktop                  | In progress | Versioned JSONL app-server, task event projection, explicit model selection, transcript/diff shell, Electron 43.2.0 secure window/preload/IPC seam, Candy browser partition, credential write-only bridge, close-vs-quit policy, and macOS arm64 packaged smoke pass                                                                 | Apple-signed child runtime, macOS `26.5.2` matrix, OS credential acceptance, packaged Browser evidence |
| 6. Local control/workspaces | Blocked     | Approval policy, clean child env, serial mutation lane, secret-aware Apply guard, argument-array Git worktree manager, binary-safe tracked/untracked Apply service, real Git fixture, and gated Rust protocol compile pass                                                                                                           | Native containment, Job Object, reviewed Apply matrix, security review                                 |
| 7. Browser Workspace        | Blocked     | Deterministic allowlist, monotonic revision, sensitive confirmation, Take Control, and owner state machine pass tests                                                                                                                                                                                                                | Packaged Electron browser and adversarial fixture evidence                                             |
| 8. Long-running/Auto Debug  | In progress | Validator-only completion, fingerprint stall detection, budget, cancellation, stop reasons, and bounded persisted progress metadata pass deterministic tests                                                                                                                                                                         | Full Task Engine integration, Desktop progress UI, native shell validator                              |
| 9. Release hardening        | Pending     | Current macOS `26.5.2` smoke baseline is repeatable                                                                                                                                                                                                                                                                                  | Remaining macOS matrix; deferred Windows 11 host matrix; packaging, recovery, evidence                 |

Statuses are `Pending`, `In progress`, `Pass`, `Fail`, or `Blocked`. A phase is `Pass` only when its mapped acceptance evidence is complete.

Windows 11 x64 implementation and acceptance are scheduled for a later work packet when a suitable host is available. For ACC-12, the current work packet measures ten runs on macOS `26.5.2` Apple Silicon first; the equivalent Windows ten-run matrix remains pending under `G0-WIN`. Both remain required for the final cross-platform V1 release claim; see `G0-WIN` in `docs/implementation/blockers-v1.md` for the deferred checklist.

## 2026-08-10 persistence and workspace checkpoint

- Latest deterministic run: format, lint, typecheck, build, 37 tests, protocol stdio, TUI smoke and read-only task smoke, app-server JSONL smoke, Pi boundary, lifecycle policy, durable queued FIFO restoration, real Git worktree fixture, and native Rust `cargo check --locked` pass on Windows.
- `SQLiteTaskStore` provides Candy-owned task metadata in app-data with WAL, full synchronization, bounded busy timeout, foreign-key enforcement, extension loading disabled, schema migration to task-run metadata, restart recovery, active-task interruption, and revision-fenced transitions. It stores no prompt, session body, attachment bytes, or credential.
- `TaskController` reloads from the metadata store; `TaskScheduler` restores queued FIFO metadata; `LongRunningTaskRunner` persists only bounded run metadata and SHA-256 fingerprint hashes.
- Checkpoint commit `c4e66333a3a0cf85ad75e90bbb81fe5033bb3f7a` is pushed and its Windows/macOS GitHub push and associated checks passed.
- Renderer contracts expose credential presence and write/delete operations only. No provider credential was read or requested.
- The app-server controller now validates every command at the protocol boundary, enforces command/revision fencing, emits streaming-safe task events, and keeps deterministic fixture prompts out of SQLite metadata.
- `PiAgentEngine` now exercises the public Pi SDK AgentSession with only the read tool, injects a short-lived in-memory secret lease, persists in Candy-owned session storage, and clears the lease after the turn. The deterministic test fixture observed `turn.started`, `assistant.delta`, and `turn.completed` and found no credential in the session JSONL.
- `KeyringCredentialStore` uses exact `@napi-rs/keyring@1.3.0` service/account identifiers (`candy-v1/deepseek`, `candy-v1/minimax-token-plan`) and has no file, CLI, or other-tool fallback. Real Keychain/Credential Manager evidence remains blocked.
- MiniMax M3 deterministic request/SSE parsing is domestic-only at `https://api.minimaxi.com/anthropic/v1/messages`; it is not enabled until LIVE-MM and Token Plan entitlement pass.
- Shell remains `unsupported`; MiniMax remains disabled; Browser is deterministic-only; actual Electron packaging, OS credential stores, macOS native containment, and signing are not advertised as passed.

## 2026-08-10 interactive TUI checkpoint

- `InteractiveTui` now uses the platform-owned application-data root, creates durable task metadata, restores active tasks as `interrupted`, assigns one owner per running task, drains a FIFO queue with the bounded scheduler, streams Pi observations, and supports `:tasks`, `:cancel <task-id>`, and `:quit`.
- The interactive TUI accepts an injected engine and streams a deterministic fixture response in its unit test; the test covers creation, task listing, Pi-shaped observations, and completion without storing prompt text in SQLite metadata.
- Local verification passed: format, typecheck, full test suite (44 tests), and the existing TUI/app-server/native smoke commands. This is not a packaged Desktop or live-provider acceptance claim.

## 2026-08-10 models, workspace transfer, and Desktop shell checkpoint

- Task metadata schema 3 persists the explicit model id with a DeepSeek V4 Flash default. The versioned protocol and Desktop preload/main path validate and project DeepSeek Flash, DeepSeek Pro, and MiniMax M3 without provider payloads.
- `PiAgentEngine` rejects DeepSeek image turns with an explicit switch-to-MiniMax result. `MiniMaxPiAgentEngine` uses Pi 0.84.1's domestic `minimax-cn` M3 model and typed image content; its deterministic SSE fixture observed the domestic `/anthropic/v1/messages` request and no fallback.
- `GitWorktreeManager` executes Git through argument arrays and a sanitized child environment. `ApplyChangesService` checks target Git identity/cleanliness/base/containment/symlink/secret gates, runs `git apply --check` before apply, transfers untracked files with binary-safe bytes, and leaves the target index untouched in the fixture.
- The Desktop shell now renders model/profile/task controls, task actions, transcript, and changed-file projection under a nonce CSP. The Browser view is separate and hidden until the Browser Workspace capability is enabled.
- Long-running stop metadata now distinguishes approval required, ownership loss, provider failure, user stop, crash interruption, cancellation, budget, stall, and validator success; deterministic control tests pass.
- Local verification for this checkpoint passed: typecheck, build, and 47 tests. Live providers, OS stores, packaged app-server, native containment, Browser automation, and dual-platform evidence remain open.

## 2026-08-10 attachment, process-supervision, and browser-boundary checkpoint

- Task metadata schema 4 persists only validated Candy-owned attachment ids. The Desktop image chooser stores bytes under the Candy app-data attachment root, and the app-server resolves those bytes into typed Pi image content for the selected MiniMax task without placing binary data in session metadata or protocol events.
- The attachment handoff tests cover both the app-server-to-Pi bridge and a MiniMax task resolving one image at the engine boundary. DeepSeek image turns remain explicitly rejected; no provider fallback is enabled.
- The app-server now uses the same default three active-task slots as the Task Runtime, retains one execution owner per running task, and promotes queued run requests in FIFO order. A deterministic four-task test confirms the fourth task waits and is promoted after the first slot completes.
- The app-server preserves actionable `needs_credentials`/provider error classes without forwarding diagnostic text, makes a second owner read-only while a task is running, and records owned running work as Interrupted on close. Attachment reads verify the stored byte hash and metadata before model handoff.
- The TUI now exposes explicit pause/resume commands, persists a paused or interrupted state instead of treating every abort as cancellation, and asks the engine's recovery seam for a missing prompt before a resumed turn.
- `ProcessSupervisor` is a shell-free, argument-array POSIX supervision seam with detached process-group cancellation, bounded output capture, and an environment allowlist that strips active provider secrets. Windows execution remains explicitly unavailable until a Job Object backend exists.
- The native JSONL helper remains unsupported by design, but now rejects oversized lines and secret-shaped protocol fields/values without echoing input. Three Rust unit tests plus `cargo test --locked`, `cargo fmt --check`, and `npm run check:native` pass.
- The Electron browser partition now denies permissions, downloads, popup windows, redirects, and navigation unless a future explicit host allowlist permits an HTTPS host. Browser automation and packaged input-origin evidence remain blocked; the view stays hidden until that capability is enabled.
- Local verification passed: format, lint, typecheck, full 53-test suite, native Rust tests, and native check. This is not a live-provider, packaged, signed, macOS, Windows 11, or final ACC-01..12 acceptance claim.

## 2026-08-10 local acceptance evidence package

- Generated `docs/evidence/acceptance-v1-local-0710d00.md` for source revision `0710d004ec0ec7a40c0a1969f1b50800ef5a3277`. It records the exact toolchain, lockfile digest, sanitized deterministic checks, ACC-01 through ACC-12 classifications, and named external blockers.
- The package intentionally classifies every acceptance gate as Blocked or incomplete where required live, packaged, platform, or security evidence is unavailable. It contains no provider credential, reversible credential fingerprint, session, browser authentication data, unrelated source, or full process environment.

## 2026-08-10 macOS Apple Silicon Desktop checkpoint

- The current M2 Pro development machine is macOS `26.5.2` arm64, the accepted macOS baseline under ADR-0008; its completed smoke is not yet the full acceptance matrix.
- The Desktop credential bridge now calls the real Main-process Keychain handlers, and every Desktop IPC handler rejects non-trusted renderers. The packaged Node 22 runtime also loads the bundled Keychain native addon and passes the two-account fixture.
- Electron `43.2.0` launches an independent Node `22.23.2` app-server in development and packaged local smoke. The packaged `out/macos/Candy.app` has an ad-hoc signature and passes `codesign --verify --deep --strict`, typed JSONL snapshot round-trip, and quit cleanup.
- `npm run check`, `npm run check:native`, and `npm run smoke:desktop:packaged` pass with 53 tests. This does not close Apple Developer signing/notarization, live provider, Browser, native containment, recovery, or final ACC-01..12 gates.

## 2026-08-10 macOS acceptance runner checkpoint

- Added `npm run acceptance:macos`, a repeatable local entry point that runs the pinned toolchain check, full deterministic check, native check, TUI, app-server, Electron, packaged Desktop, and packaged Keychain smoke commands in serial order.
- The runner uses Candy's minimal child-environment allowlist, never enables live providers, records only sanitized metadata, and writes ignored reports under `out/acceptance/macos/`.
- The local run passed all 8 steps on macOS `26.5.2` arm64 with Node `22.23.2`, 53 tests, native checks, packaged JSONL lifecycle, and the packaged Keychain fixture. The latest local report is `out/acceptance/macos/latest.md`.
- This closes the repeatability seam for local macOS `26.5.2` evidence but does not change the status of the remaining macOS matrix, live-provider, signing, Browser, native containment, recovery, or final ACC gates.

## 2026-08-10 provider-chain checkpoint

- Added explicit `gate:live:deepseek` and `gate:live:minimax` commands. They require the provider-specific opt-in path, accept only Candy-owned temporary environment credentials, remove both provider variables before creating the Pi engine, use a temporary Candy-owned fixture outside the repository, and write sanitized local results under `out/acceptance/live/`.
- The no-credential DeepSeek run was exercised and correctly produced `Blocked` without a network request or credential-shaped output.
- The Pi adapter now accepts an explicit thinking level and forwards public Pi `thinking_delta` events as typed `assistant.thinking.delta` observations through Runtime and app-server protocol layers. The new protocol and adapter fixtures pass; Desktop visual presentation is intentionally deferred.
- Live DeepSeek/MiniMax credentials, Token Plan console evidence, exact error-condition fixtures, and final provider Gate status remain Blocked.

## 2026-08-10 workspace and credential-entry checkpoint

- Desktop now provides a real folder picker, persists the selected Local Workspace under Candy app data, and requires that selection before creating a task. The task protocol and SQLite metadata carry the absolute workspace path; app-server validates the directory and passes it to Pi instead of using the child process cwd.
- Desktop Settings now exposes DeepSeek and MiniMax credential replace/delete/presence operations through the existing Main-process Keychain bridge. The renderer only receives `present`/`absent` and never receives a stored credential value.
- Deterministic verification passes: typecheck, lint, format, full 56-test suite, protocol boundary checks, exact Pi graph check, and lifecycle-script policy. This checkpoint does not enable live DeepSeek, mutable Pi tools, Shell, native containment, or Apply Changes in the real Desktop task path.
