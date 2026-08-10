# Candy V1 Implementation Progress

Updated: 2026-08-10

| Phase                       | Status      | Evidence                                                                                                                                                                                                                   | Remaining                                                                 |
| --------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 0. Compatibility Gate       | In progress | Accepted architecture and conditional Gate reports                                                                                                                                                                         | Live credentials, macOS, native/security verification                     |
| 1. Repository foundation    | Pass        | Phase 1 and later checkpoint CI pass on Windows and macOS 15 ARM; Pi closure is 7 packages at `0.84.1`; lockfile is stable                                                                                                 | None in deterministic local scope                                         |
| 2. Runtime proof            | Blocked     | Pi public `AgentSession` path now runs with a temporary in-memory credential store, read-only Pi tool allowlist, streamed deltas, Candy-owned session JSONL, and secret-free session assertion; DeepSeek HTTP seam remains covered | Live DeepSeek contract and macOS Runtime evidence                         |
| 3. Task Runtime and TUI     | In progress | Task lifecycle, revision fencing, FIFO scheduler, durable queued FIFO restoration, leases, approval profiles, read-only runtime, mutation serialization, SQLite metadata, TaskController recovery, interactive TUI prompt/task/cancel loop, model persistence, and durable app-server create/run/pause/resume/cancel event loop pass | Full interactive TUI and process-restart ownership/cancellation matrix    |
| 4. Models and attachments   | Blocked     | Code-owned DeepSeek Flash/Pro and domestic MiniMax catalog, Pi-backed MiniMax M3 image turn, deterministic DeepSeek/MiniMax streaming seams, hashed image store, video-disabled behavior, and no-fallback policy pass deterministic tests | Live provider contracts and MiniMax entitlement                           |
| 5. Desktop                  | Blocked     | Versioned JSONL app-server, task event projection, explicit model selection, transcript/diff shell, Electron 43.2.0 secure window/preload/IPC seam, Candy browser partition, credential write-only bridge, and close-vs-quit policy exist | Signed child runtime, OS credential verification, packaged evidence       |
| 6. Local control/workspaces | Blocked     | Approval policy, clean child env, serial mutation lane, secret-aware Apply guard, argument-array Git worktree manager, binary-safe tracked/untracked Apply service, real Git fixture, and gated Rust protocol compile pass | Native containment, Job Object, reviewed Apply matrix, security review    |
| 7. Browser Workspace        | Blocked     | Deterministic allowlist, monotonic revision, sensitive confirmation, Take Control, and owner state machine pass tests                                                                                                      | Packaged Electron browser and adversarial fixture evidence                |
| 8. Long-running/Auto Debug  | In progress | Validator-only completion, fingerprint stall detection, budget, cancellation, stop reasons, and bounded persisted progress metadata pass deterministic tests                                                               | Full Task Engine integration, Desktop progress UI, native shell validator |
| 9. Release hardening        | Pending     | None                                                                                                                                                                                                                       | Full matrix, packaging, recovery, evidence                                |

Statuses are `Pending`, `In progress`, `Pass`, `Fail`, or `Blocked`. A phase is `Pass` only when its mapped acceptance evidence is complete.

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
