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
| 6. Local control/workspaces | Blocked     | Approval policy, clean child env, serial mutation lane, secret-aware Apply guard, argument-array Git worktree manager, binary-safe tracked/untracked Apply service, Desktop Task Worktree handoff with persisted association, real Windows 11 Git worktree/Apply fixtures, and junction escape rejection pass | Native containment, Job Object, remaining Windows reparse-point matrix, security review                |
| 7. Browser Workspace        | Blocked     | Deterministic allowlist, monotonic revision, sensitive confirmation, Take Control, and owner state machine pass tests                                                                                                                                                                                                                | Packaged Electron browser and adversarial fixture evidence                                             |
| 8. Long-running/Auto Debug  | In progress | Validator-only completion, fingerprint stall detection, bounded three-round Auto execution, cancellation, stop reasons, bounded persisted progress metadata, explicit pause/resume, crash interruption, and Desktop run-progress projection pass deterministic tests                                                                 | User steering/approval integration, final evidence summary, native shell validator, packaged/platform evidence |
| 9. Release hardening        | Pending     | Current macOS `26.5.2` smoke baseline is repeatable; Windows 11 x64 host is now available for deterministic work                                                                                                                                                                                                                        | Remaining macOS and Windows matrices; packaging, recovery, evidence                                    |

Statuses are `Pending`, `In progress`, `Pass`, `Fail`, or `Blocked`. A phase is `Pass` only when its mapped acceptance evidence is complete.

Windows 11 x64 implementation and acceptance now continue on the current Windows 11 Pro x64 host. For ACC-12, the ten-run Windows measurement remains pending under `G0-WIN`; it and the macOS `26.5.2` Apple Silicon measurement are both required for the final cross-platform V1 release claim. See `G0-WIN` in `docs/implementation/blockers-v1.md` for the active checklist.

## 2026-08-10 Windows 11 deterministic worktree checkpoint

- The current development host is Windows 11 Pro x64. After a clean `npm ci --ignore-scripts`, the complete deterministic gate passes: format, lint, typecheck, 88 tests, protocol boundaries, exact Pi closure, and lifecycle policy. The durable TUI task and app-server JSONL smokes also pass under Node `22.23.2`.
- `resolveDefaultAppDataRoot` now selects `path.win32` or `path.posix` from the requested target platform rather than leaking the host separator into simulated macOS or Windows paths.
- `GitWorktreeManager` now parses NUL-delimited `git worktree list --porcelain -z` records, canonicalizes the recorded worktree path, and requires the exact lock reason. It no longer accepts a substring match from an unrelated worktree.
- Windows workspace-boundary coverage uses a directory junction, which is available to a normal Windows user session, and confirms the Pi tool host rejects traversal into the junction target. Real Git task creation, Apply, discard, and restart handoff fixtures now pass on Windows.
- This closes no acceptance Gate by itself. Windows Job Object containment, broader reparse-point fixtures, packaged Desktop/Keyring, signing, recovery, Browser, live providers, and ACC-12 remain open.

## 2026-08-10 explicit local credential-import checkpoint

- Added a development-only, opt-in OpenCode DeepSeek importer. It accepts only an explicitly provided absolute `auth.json` path inside an OpenCode directory, selects only the `deepseek` API entry, rejects sources inside the Candy repository, and writes directly to Candy's `candy-v1/deepseek` OS credential-store account.
- The importer requires `--confirm-opencode-import`; replacing an existing Candy credential additionally requires `--replace`. It emits only sanitized status and never projects the credential into sessions, JSONL, logs, tool subprocess environments, or repository files.
- This does not add runtime credential synchronization to Candy V1 and does not change the live-provider Gate status. `LIVE-DS-01..04` and the required platform/entitlement evidence remain separate acceptance work.

## 2026-08-10 live DeepSeek development checkpoint

- The explicit local importer wrote the user-authorized OpenCode `deepseek` API entry directly to Candy's `candy-v1/deepseek` Keychain account. The command emitted only sanitized status and the credential was not placed in the repository or acceptance report.
- The real Pi-backed `npm run gate:live:deepseek` run at source revision `ac78b9eb9b1f545e708f31cae470249faa24baf3` reported 6 passed and 1 blocked: `LIVE-DS-01`, `LIVE-DS-02`, `LIVE-DS-03`, cancellation, secret-free session scan, and secret lease release passed; `LIVE-DS-04-error-contracts` remains blocked because controlled 401/429/timeout fixtures are not yet available.
- `G0-LIVE-DS` and `G0-DS-ADAPTER` remain blocked until the controlled provider-error evidence and the remaining required platform/acceptance evidence are complete.

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

## 2026-08-10 safe editing and macOS validator checkpoint

- Pi's documented public tool-definition factories are now wrapped by Candy workspace operations. Read-only tasks expose only `candy_read`; Auto tasks expose `candy_read`, `candy_edit`, and `candy_write`. Candy rejects traversal and symlink escapes and does not enable Pi's built-in shell or other built-in tools.
- The Rust Sandbox Runner now implements the versioned macOS JSONL validator path. It launches absolute executables through `/usr/bin/sandbox-exec`, denies network access, clears the child environment, bounds output, rejects credential-shaped requests, and returns typed completion data. The TypeScript boundary adds active-secret stripping and output redaction.
- Validator configuration is carried through protocol and SQLite metadata and can be supplied from the Desktop as an absolute executable plus JSON string-array arguments. The app-server runs it only after the Pi turn and does not auto-commit or auto-push.
- `npm run smoke:safe-edit` now exercises a local TypeScript fixture through read, edit, native validator, diff, and commit-invariance checks. The fixture is temporary, uses a Git baseline only for observation, and is removed after the run.
- Local verification on macOS `26.5.2` arm64 covers the real native binary, workspace read/write/mkdir guards, Pi tool construction, validator execution, app-server validator ordering, protocol validation, and the full deterministic suite.
- This checkpoint does not clear G2 native security review: the current Seatbelt profile keeps the default filesystem policy while Candy's TypeScript guard enforces selected-workspace file operations. A stronger workspace-only profile, cancellation/descendant evidence, packaged runner path, real DeepSeek gate, diff/Apply UI, restart recovery, and final acceptance evidence remain open.

## 2026-08-10 workspace diff projection checkpoint

- `GitWorkspaceChangeTracker` captures the selected Git workspace HEAD at task creation and reports tracked, untracked, and binary-safe patch data after the Pi turn without mutating the workspace.
- The versioned protocol now carries `workspace.changes`; the app-server emits it before completion and refreshes it for an explicit task snapshot. Desktop projects it into real `changedFiles` and diff text instead of a placeholder file list.
- Active DeepSeek and MiniMax credentials are leased only for diff redaction and released immediately; a canary test confirms the credential cannot enter the workspace-change event.
- Deterministic verification passes: format, lint, typecheck, `npm test` (63 tests), boundary/version/lifecycle checks, native check, app-server JSONL smoke, safe-edit smoke, and Desktop smoke under Node `22.23.2`.
- This checkpoint is review-only. It does not enable Apply Changes in Desktop, persist the baseline across app-server restart, close the dirty/base/conflict Apply matrix, or change the blocked live-provider, native-containment, signing, Windows, or final ACC-01..12 status.

## 2026-08-10 Desktop Apply and persisted baseline checkpoint

- SQLite task metadata schema 7 now persists the captured Git workspace baseline (`workspace_baseline`) per task. The app-server stores the baseline at creation and restores it after restart; snapshots carry the validated `workspaceBaseline` through the protocol.
- The versioned protocol adds a `workspace.apply` command carrying the expected base and explicit tracked/untracked relative path manifests. The app-server re-inspects the workspace before Apply, requires a completed task with released ownership, and blocks when the reviewed manifest, base, or complete-patch condition changed.
- `ApplyChangesService` now supports the reviewed same-root Local Workspace path by verifying the reviewed diff still matches instead of re-applying or touching the index, and it treats an explicit untracked manifest as authoritative. Cross-worktree transfer continues to use `git apply --check`, binary-safe apply, and index-free untracked copying.
- Workspace change events now carry `patchTruncated`; Desktop hides/disables Apply for truncated diffs and the app-server rejects Apply without a complete reviewed patch. This prevents a bounded review display from becoming a partial write.
- Desktop now exposes an Apply Changes button on completed tasks with reviewed changes, sends the persisted baseline and tracked/untracked manifests through the trusted IPC bridge, and reports the result in the task shell.
- Local verification passed: format, lint, typecheck, 71 tests, boundary/version/lifecycle checks, native check, app-server JSONL smoke, safe-edit smoke, Desktop smoke, and packaged macOS Desktop/Keychain smoke under Node `22.23.2`.
- This checkpoint does not yet wire Task Worktree handoff into the Desktop task path, does not close the dirty target/changed-base/conflict and Windows path matrix, and does not change the blocked live-provider, native-containment review, signing, Browser, or final ACC-01..12 status.

## 2026-08-10 Task Worktree handoff and Apply matrix checkpoint

- Desktop task path now uses a real Task Worktree for writable Git tasks: at `task.create`, an auto-profile task on a Git baseline gets a locked detached worktree under Candy's app-data `worktrees/<task-id>` via the argument-array Git manager; the Pi turn, prompt recovery, validator, and diff projection run in that worktree.
- `workspace.apply` transfers the reviewed patch from the Task Worktree into the selected Local Workspace as uncommitted changes, then discards and removes the clean worktree; `workspace.discard` explicitly discards a completed worktree without touching Local. Both require a completed task with released ownership, and blocked Apply keeps the worktree so the user can retry after fixing the target.
- SQLite task metadata schema 8 persists `worktree_path`; app-server restart restores the worktree association and can still Apply. Snapshots carry `workspaceState: local|worktree` and `worktreePath`; Desktop projects the state, enables Apply only for a completed worktree review, and adds a Discard worktree action through the trusted IPC bridge.
- `GitWorktreeManager.discard` resets the Candy-owned worktree to its recorded base, cleans untracked files, unlocks, and removes it; dirty removal and force removal are not used.
- The Apply matrix now passes real Git fixtures for dirty target, changed base, patch conflict (`git apply --check` refusal), and untracked-path collision, plus deterministic Windows-path coverage for worktree planning and Apply guard escapes using a `path.win32` seam; protocol and Desktop contracts keep Windows absolute paths valid and relative Git paths backslash-free.
- Local verification passed: format, lint, typecheck, 79 tests, boundary/version/lifecycle checks, native check, app-server JSONL smoke, safe-edit smoke, Desktop smoke, and packaged macOS Desktop/Keychain smoke under Node `22.23.2`.
- This checkpoint does not change the blocked live-provider, native-containment review, signing, Browser, Windows 11 host matrix, or final ACC-01..12 status.

## 2026-08-10 long-running Task Engine integration checkpoint

- Auto tasks with an explicit validator now alternate normal Pi turns with the same validator through `LongRunningTaskRunner`, using a bounded three-round default and completing only after validator success. A failed validator produces another normal turn; repeated unchanged validator fingerprints pause the task as `stall_detected`.
- The app-server persists only bounded task-run metadata after each validator result: rounds, evidence count, completion, stop reason, and a SHA-256 fingerprint hash. The protocol snapshot carries the same bounded progress without evidence text, and Desktop renders round, evidence count, and stop reason.
- User pause/cancel uses typed long-running control reasons. A new app-server marks uncertain active tasks `interrupted` with `crash_interrupted`; resume remains explicit and uses the recoverable engine prompt seam. Provider failures are classified as `provider_failure` in persisted run metadata and as an actionable protocol error.
- Deterministic app-server coverage now includes multi-round validator retry, persisted progress, pause/resume after restart, crash interruption before explicit resume, and successful completion. This checkpoint does not enable shell-based Auto Debug, user steering/approval orchestration, live providers, or final platform acceptance.
