# Candy V1 Implementation Progress

Updated: 2026-08-13

可持续更新的实施待办见 [Candy V1 待办与进度](todolist-v1.md)。其中 `☑️` 仅表示对应范围已经验证完成，`◐` 会明确列出剩余验收条件。

| Phase                       | Status      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Remaining                                                                                                            |
| --------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 0. Compatibility Gate       | In progress | Accepted architecture, conditional Gate reports, macOS DeepSeek live matrix at 7/7, and macOS MiniMax LIVE-MM-01..04 plus secret checks at 7/7; LIVE-MM-05 defaults to Pass by product policy                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Exact macOS `26.5.2` regression when that compatibility claim is required, remaining platform evidence, and native/security verification |
| 1. Repository foundation    | Pass        | Phase 1 and later checkpoint CI pass on Windows and Apple Silicon macOS; current-host deterministic checks and historical `26.5.2` baseline evidence are recorded; Pi closure is 7 packages at `0.84.1`; lockfile is stable                                                                                                                                                                                                                                                           | None in deterministic local scope                                                                                    |
| 2. Runtime proof            | Blocked     | Pi public `AgentSession` path now runs with a temporary in-memory credential store, read-only Pi tool allowlist, streamed deltas, Candy-owned session JSONL, secret-free session assertion, and the macOS DeepSeek live Gate at 7/7                                                                                                                                                                                                                                                                                                          | Remaining macOS Runtime/UI/recovery and cross-platform acceptance evidence                                           |
| 3. Task Runtime and TUI     | In progress | Task lifecycle, revision fencing, FIFO scheduler, durable queued reorder, leases, approval profiles, read-only runtime, mutation serialization, SQLite metadata, TaskController recovery, interactive TUI prompt/task/cancel/reprioritize loop, explicit file Auto with read/create/edit/delete, per-delete approval, model persistence, continuous same-task turns, durable TUI transcript projection, workspace changes/diff review, explicit native validator control, explicit model/attachment controls, provider-failure recovery hints, and durable app-server create/run/pause/resume/cancel/reorder event loop pass                                                                                                                     | Shell/command execution after G2 and full ownership/recovery matrix |
| 4. Models and attachments   | Blocked     | Code-owned DeepSeek Flash/Pro and domestic MiniMax catalog, explicit TUI model aliases and persistence, Pi-backed MiniMax M3 typed image turns, validated Candy-owned image storage, path/symlink/workspace/app-data/size/MIME/corruption rejection, attachment-id restart recovery, domestic endpoint, and no-fallback policy pass deterministic tests                                                                                                                                                                                                                                                              | Complete ACC-04/release evidence and any remaining platform/provider acceptance                                             |
| 5. Desktop                  | In progress | Versioned JSONL app-server, task event projection, explicit model selection, transcript/diff shell, Electron 43.2.0 secure window/preload/IPC seam, Candy browser partition, credential write-only bridge, Windows Credential Manager synthetic lifecycle smoke, unsigned Windows x64 packaged Node/app-server/native-runner JSONL smoke, close-vs-quit policy, macOS arm64 packaged smoke, packaged macOS credential-isolation and coding-journey/reopened-transcript fixtures, and ten-run deterministic ACC-12 responsiveness subset pass | Apple/Windows signed installation, Windows/macOS OS credential acceptance, complete packaged Browser evidence        |
| 6. Local control/workspaces | In progress | Approval policy, clean child env, serial mutation lane, secret-aware Apply guard, argument-array Git worktree manager, binary-safe tracked/untracked Apply service, Desktop Task Worktree handoff with persisted association, real Windows 11 Git worktree/Apply fixtures, junction escape rejection, and Windows Job Object descendant-cancellation smoke pass                                                                                                                                                                              | OS-level no-network/workspace containment, remaining Windows reparse/race matrix, security review                    |
| 7. Browser Workspace        | In progress | Deterministic allowlist, monotonic revision, sensitive confirmation, Take Control, owner state machine, Candy-owned persistent partition, packaged Windows/macOS WebContentsView fixtures, structured action/screenshot bridge, default-deny navigation/popup/permission/download, and partial adversarial rejection smoke pass                                                                                                                                                                                                              | Physical input-origin detection, complete adversarial page matrix, and complete Browser/ACC-09/ACC-12 evidence       |
| 8. Long-running/Auto Debug  | In progress | Validator-only completion, fingerprint stall detection, bounded three-round Auto execution, cancellation, stop reasons, bounded persisted progress metadata, explicit pause/resume, crash interruption, Desktop run-progress projection, and Windows/macOS packaged approval/steering/validator evidence                                                                                                                                                                                                                                     | User steering/approval integration, OS-level command containment, final evidence summary, packaged/platform evidence |
| 9. Release hardening        | Pending     | Current macOS Tahoe `26.x` primary smoke is repeatable; exact macOS `26.5.2` regression runner and Windows 11 x64 unsigned packaged development smoke are tracked separately                                                                                                                                                                                                                                                                                                                                                     | Exact-baseline macOS evidence, Windows matrices; signed packaging, recovery, evidence      |

Statuses are `Pending`, `In progress`, `Pass`, `Fail`, or `Blocked`. A phase is `Pass` only when its mapped acceptance evidence is complete.

## 2026-08-13 macOS acceptance policy checkpoint

- The primary macOS acceptance runner now targets the current Tahoe `26.x` arm64 host, accepts versions at or above `26.5.2` within major `26`, records the exact host version, and writes current-host evidence to `out/acceptance/macos/latest.md`.
- Added `npm run acceptance:macos:baseline` for the exact `26.5.2` arm64 compatibility regression matrix. It writes `out/acceptance/macos/baseline-latest.md` and cannot overwrite current-host evidence.
- This policy separates current-host Personal Preview validation from an older exact-version compatibility claim. It does not infer native containment, terminal, Keychain, Electron, recovery, or provider behavior across OS versions without evidence from the exact host.
- The current MacBook Pro reports macOS Tahoe `26.6.1` arm64. On published revision `ace1c12fbd9115be34f66aca74107180499b5e4b`, `npm run acceptance:macos` passed `21/21` with Node `22.23.2`/npm `10.9.8`; the sanitized report is `out/acceptance/macos/latest.md`.
- Running `npm run acceptance:macos:baseline` on this host correctly blocked before execution because exact `26.5.2` was unavailable and wrote `out/acceptance/macos/baseline-latest.md`; the exact regression run remains pending until that host is available. The current-host result is deterministic and packaged evidence only, not final V1, signing, Windows, live-provider, G2, or complete ACC acceptance.

## 2026-08-12 WP1 restricted-resource-loader checkpoint

- `PiAgentEngine` now passes `CandyRestrictedResourceLoader` and an in-memory `SettingsManager` with `projectTrusted: false` to Pi's public `createAgentSession` API. The adapter does not invoke Pi's `DefaultResourceLoader`, `DefaultPackageManager`, or resource discovery path.
- The restricted loader returns empty extensions, skills, prompts, and themes; rejects non-empty resource extension requests; and reads only a bounded, non-symlink root `AGENTS.md` with credential-shaped content redacted. Returned context data is copied at the boundary.
- The hostile workspace fixture covers `.pi/settings.json` package configuration, extension/skill/prompt/theme resources, an executable subprocess probe, an install probe, a symlink, a network canary, and a credential canary. The fixture passes with no marker, non-provider request, `.pi` content, or credential exposure in the request/session.
- The contract fixture now injects a Candy-owned filesystem tripwire. It records the loader's approved root `AGENTS.md` accesses and fails immediately if any loader operation reaches `.pi`, so resource reads/enumeration are observable rather than inferred only from session output.
- Validation on this host: Node `22.23.2`, npm `10.9.8`, the full `npm run check` passes format, lint, typecheck, all 111 repository tests, Pi boundary/version checks, and lifecycle policy when run outside the restricted shell. In the restricted shell, the same three pre-existing macOS Sandbox Runner tests fail with `sandbox-exec: sandbox_apply: Operation not permitted` (`71`/`false`); the direct runner probe passes with code `0` outside that shell, and WP1 changed no `packages/runtime` or `native/sandbox-runner` files between `5f9f4b5` and this checkpoint. This is a harness limitation, not a WP1 runtime regression, and remains separate from macOS/Windows platform acceptance or a final security/release Pass.
- WP1 has passed the architect gate and independent hostile-fixture QA. WP2 is the active checkpoint; WP3 native-process and WP4 read-only tool reuse remain unopened until their predecessor gates pass. Shell Auto and Shell Auto Debug remain disabled.

## 2026-08-12 WP2 minimal pi-tui vertical slice checkpoint

- `apps/tui` now directly pins `@earendil-works/pi-tui@0.84.1`. `scripts/check-boundaries.mjs` enforces the exact Pi allowlist: `packages/pi-adapter` may use only `@earendil-works/pi-coding-agent`, `apps/tui` may use only `@earendil-works/pi-tui`, and other source packages may not import Pi.
- `CandyTuiSurface` uses only public `TuiAltScreen`, `ProcessTerminal`, `Editor`, `Text`, and key matching. `InteractiveTui` retains Candy command parsing (`:tasks`, `:pause`, `:resume`, `:cancel`, `:quit`), task state, scheduling, Runtime calls, and session ownership. A Candy-owned FakeTerminal covers normal, Ctrl+C, startup-error, and runtime-error cleanup.
- The surface rejects non-empty `PI_TUI_WRITE_LOG`, `PI_TUI_DEBUG`, and `PI_DEBUG_REDRAW`, receives an explicit `<app-data>/logs` path, and redacts secret-shaped transcript output. No `TuiMainScreen`, Pi interactive mode, plugin, remote protocol, or second session store was added.
- Deterministic validation for this checkpoint: Node `22.23.2`, npm `10.9.8`, incremental lint with zero new errors, build, six TUI surface/controller tests, and the exact Pi boundary check. The complete repository check remains the release gate for this commit; no native files changed, so no Rust test was required.
- Evidence boundary: local FakeTerminal tests do not claim macOS raw-mode, Ctrl+C, exception recovery, paste, Chinese input, resize, IME, or Windows 11 real-terminal acceptance. Shell Auto and Shell Auto Debug remain disabled.

## 2026-08-13 TUI file CRUD checkpoint

- `InteractiveTui` keeps Read-only as the startup profile and adds explicit `:profile auto` / `:profile read-only` selection for subsequent tasks. File Auto passes Candy's existing `candy_read`, `candy_edit`, and `candy_write` tools through the Pi `AgentSession` path; it does not enable Shell.
- Added Candy's narrow `candy_delete` custom tool using the public Pi `ToolDefinition` and mutation-queue surfaces. Every deletion waits for a TUI `:approve <id>` or `:deny <id>` decision, then revalidates the same regular file before unlinking it. Workspace escape, symbolic links, directories, control-character paths, cancellation, denial, and targets changed during approval fail closed.
- Deterministic verification on macOS uses Node `22.23.2` and npm `10.9.8`: `npm run check:toolchain`, `npm run check` at 139/139 tests, `npm run check:native`, `npm run smoke:tui`, and `npm run smoke:tui-task` pass. No live provider call or real credential was used for this checkpoint.
- Evidence boundary: file CRUD is now wired into the TUI control plane, but this is not complete ACC-03 or a primary-tool claim. Iterative follow-up turns, model/MiniMax image selection, validator execution and result presentation, changed-file/diff review, shell/test commands, robust restart/handoff, and broader real-terminal acceptance remain separate work. Shell Auto and Shell Auto Debug stay disabled pending G2.

## 2026-08-13 TUI continuous-task checkpoint

- `InteractiveTui` now maintains an explicit current task. Ordinary input continues a completed, paused, or interrupted task through one revision-fenced continuation queue; `:new [prompt]` clears the current task and creates a new task for the next prompt, and `:use <task-id>` selects a persisted task.
- `:tasks` marks the current task and displays state, model, workspace, revision, and queue position. TUI startup restores controllers from Candy-owned SQLite metadata, preserves a bounded redacted transcript, and passes the persisted task model/workspace plus the stable task id to the same Pi session directory on every turn.
- Active turns reject overlapping prompts, a task owned by another client is inspectable but read-only, cancelled tasks cannot be continued, and stale task revisions fail closed. Ctrl+C, `:quit`, input exceptions, and runtime failures retain the existing terminal cleanup path.
- Test-first deterministic validation passes `npm test` with 144/144 tests, including two turns on one task id, explicit `:new`, restart plus `:use` transcript continuation, active-owner fencing, and non-owner read-only control. The full checkpoint gate remains the required toolchain/native/TUI smoke sequence below.
- Evidence boundary: this is a local FakeTerminal and deterministic engine checkpoint. It does not claim macOS raw-terminal, Windows 11 terminal, live-provider, full ACC-03, or final V1 acceptance. Shell Auto and Shell Auto Debug remain disabled.

## 2026-08-13 TUI workspace-browse checkpoint

- Added Candy-owned `candy_list` and `candy_search` read-only tools to the Pi adapter. They use only Node filesystem APIs (`readdir`, `lstat`, `realpath`, and `readFile`); Shell, `rg`, and Pi built-in tools remain outside this path, and Pi's `noTools: "builtin"` boundary remains in force.
- Both Read-only and Auto expose the two browse tools. The tools accept only bounded workspace-relative paths, reject control/invalid path text and workspace escapes, do not follow symlinks or reparse-like links, skip Candy app-data and dependency/build/cache directories, ignore binary/invalid UTF-8 files, and return workspace-relative bounded JSON results.
- Search is literal and bounded by directory/file/match/file-size/line/output limits, checks cancellation between filesystem steps, rejects credential-shaped queries, and redacts the active provider secret plus credential-shaped text before returning matches. No provider credential or external tool configuration is used.
- Test-first deterministic verification covers schemas, both approval profiles, ignored directories, workspace/symlink boundaries, invalid UTF-8/binary files, cancellation, output/line bounds, active-secret redaction, and Pi tool-name projection. This checkpoint is local source evidence only; it does not claim real macOS/Windows terminal behavior, Shell Auto, G2, complete ACC-03, or final V1 acceptance.

## 2026-08-13 TUI changes/diff/validator checkpoint

- `InteractiveTui` now captures and persists each task's workspace baseline through the shared `ResolvedWorkspaceChangeTracker`; `:changes` lists tracked, untracked, and removed paths, while `:diff [path]` filters Git sections or non-Git summaries and bounds rendered output to 64 KiB with an explicit truncation notice.
- Added explicit `:validator <absolute-executable> [args]`, `:validate`, and `:validator off` control. Validator execution uses the platform-owned native runner through Runtime's `CommandValidator`, carries no provider credential into the command, persists bounded redacted evidence, supports pass/fail/cancel/timeout, and reports `blocked` when the native runner is unavailable. There is no automatic Apply, stage, commit, push, or Shell enablement.
- The TUI now passes the persisted task workspace/model to every turn, and the app-server reuses the same exported Runtime workspace-tracker resolver instead of maintaining a duplicate implementation.
- Test-first verification passed the complete gate on Node `22.23.2`/npm `10.9.8`: `npm run check` passed **150/150** tests, `npm run check:toolchain`, `npm run check:native`, `npm run smoke:tui`, `npm run smoke:tui-task`, `npm run smoke:app-server`, and `npm run smoke:safe-edit` passed, and `git diff --check` was clean.
- Evidence boundary: this is deterministic TUI and local native-boundary evidence. It does not claim real macOS raw-terminal or Windows 11 terminal acceptance, live-provider coding, G2 OS command containment, Shell Auto/Shell Auto Debug, full ACC-03/05/11, or final V1 acceptance.

## 2026-08-13 TUI model/attachment checkpoint

- `InteractiveTui` now accepts `:model`, `:model deepseek-flash`, `:model deepseek-pro`, and `:model minimax-m3`; canonical model ids are persisted in each task and model changes are rejected during active or queued execution. The default TUI composition routes DeepSeek and MiniMax through separate Pi engines, so selecting MiniMax never silently falls back to DeepSeek.
- `:attach <absolute-path>` and `:attachments` use the Candy-owned `AttachmentStore`. Image ids, MIME, and bounded byte metadata are persisted; binary payloads stay in Candy app-data. Workspace/Candy app-data paths, final symlinks, videos, unsupported MIME, oversized files, corrupt images, and credential-bearing content are rejected. DeepSeek image tasks fail closed with an explicit MiniMax M3 instruction, and persisted MiniMax image attachments recover after TUI restart.
- Test-first deterministic verification passes `npm test` with 155/155 tests, including all three model choices, active-turn rejection, typed MiniMax image content, DeepSeek no-fallback, domestic endpoint, attachment validation, redacted provider failure contracts, and attachment restart recovery. The full checkpoint gate remains `check:toolchain`, `check:native`, TUI/app-server/safe-edit smokes, and `git diff --check`.
- Evidence boundary: this is local deterministic TUI/Pi-adapter/AttachmentStore evidence. It does not claim live MiniMax usage, real macOS raw-terminal or Windows 11 terminal behavior, complete Desktop attachment UX, G2 OS command containment, complete ACC-03/04/11, or final V1 acceptance.

## 2026-08-13 TUI provider-failure recovery checkpoint

- `ProviderContractError` now maps to a fixed, provider-safe user message for missing credentials, unauthorized, rate-limited, timeout, network, malformed-response, and endpoint failures; provider-supplied diagnostic text is not rendered.
- An interrupted provider turn now prints explicit between-turn recovery actions: `:resume <task-id>`, an explicit `:model` change, or `:cancel <task-id>`. Paused and interrupted tasks can be explicitly cancelled without replaying a turn.
- Test-first TUI evidence covers the timeout classification, redacted output, recovery actions, and interrupted-task cancellation; the full repository gate is recorded after the checkpoint verification below.
- The previous exact-version preflight is superseded by the current-host/baseline split documented in the macOS acceptance policy checkpoint below. Current-host acceptance runs on Tahoe 26.x; `acceptance:macos:baseline` remains exact-version gated.

## 2026-08-13 TUI real-PTY Personal Preview checkpoint

- Added the read-only `:transcript [task-id]` command so a restarted TUI can explicitly inspect the durable Candy transcript before continuing a task. It does not add a second session store or change task ownership.
- Added `smoke:tui:journey:macos`: an Expect-backed real PTY launches the actual `ProcessTerminal`/`TuiAltScreen`, uses a temporary Git workspace/TMPDIR/Candy app-data root, runs the Candy workspace tools through a deterministic MiniMax image fixture, covers two same-task turns, deny/approve deletion, changed-file/full-diff review, an explicit native validator, Apply to Local, quit/restart, and restored task state.
- The journey asserts workspace-external sentinel preservation, unchanged Git HEAD/index/commit count, persisted transcript/tool results/model/attachment/validator state, no credential-shaped or synthetic-canary evidence in PTY/app-data/diff plus the parent Expect stdout/stderr capture, and alternate-screen/cursor restoration. It is included in the macOS acceptance step list.
- The macOS acceptance runner writes a sanitized current-HEAD `Blocked` preflight report for the selected mode when its target host is unavailable (`latest.md` for current-host mode and `baseline-latest.md` for exact-baseline mode); it runs no acceptance step in that case.
- Current host evidence: macOS Tahoe `26.6.1` arm64, deterministic fixture, validator pass, transcript/model/attachment/task recovery pass. This is real-terminal evidence on the primary current host; exact `26.5.2` compatibility regression, live-provider journey, Windows terminal, G2, and final V1 acceptance remain separate.

## 2026-08-13 TUI workspace-selection checkpoint

- Added `:workspace [absolute-path]` to the TUI. It reports the current default workspace, rejects relative/control-character/non-directory paths, canonicalizes an existing directory, and applies the selection only to subsequent `:new` tasks; an existing task keeps its persisted workspace.
- The task-creation path snapshots the selected workspace before asynchronous baseline capture, so metadata and change review cannot bind to different directories if the user changes the default during startup.
- Test-first evidence covers invalid paths, an absolute path containing spaces, two sequential tasks using different selected workspaces, canonical `/private` path handling, and persisted task metadata. The real macOS PTY journey now launches from the workspace parent and selects the workspace inside the TUI before exercising the full coding loop.
- Current host evidence is macOS Tahoe `26.6.1` arm64. This closes the TUI workspace-selection implementation slice only; it does not close the separate exact `26.5.2` compatibility regression, and Desktop remains lower priority for this continuation.

## 2026-08-12 WP3 native-process boundary checkpoint

- `@candy/runtime` now exposes only the platform-neutral `CommandRunner` port and common `CommandValidator` for command-validator execution. The validator retains the existing bounded, active-secret-redacted evidence and cancellation result contract.
- Added `@candy/platform`'s `native-process` adapter. It centralizes the existing JSONL v1 client, absolute runner path resolution, safe child-environment construction, request secret rejection, bounded output, and macOS process-group / Windows direct cancellation strategy. The Rust crate, JSONL fields/version, no-network flag, and native error semantics were not changed.
- `apps/app-server` now injects the concrete `NativeProcessRunner` and `CommandValidator` at the composition root. `smoke-safe-edit`, `smoke-sandbox-macos`, and `smoke-native-windows` use the same split; no Electron packaging or Browser host adapter was widened.
- Deterministic source validation added platform-owned path/platform rejection coverage. Full `npm run check`, `cargo test --locked`, and the available macOS native/smoke checks remain required before this checkpoint can be marked independently QA-verified.
- Evidence boundary: this is an implementation boundary checkpoint, not G2, Windows 11, signed packaging, independent security review, Shell Auto, Shell Auto Debug, or final V1 acceptance evidence.

## 2026-08-12 WP3 P1 nested JSON active-secret repair

- Independent QA reopened WP3 on `fdf6b453`: an active credential containing JSON-special characters could be embedded through nested JSON representations in a command argument, reach the real macOS runner, and execute before the prior one-layer scan rejected it. The earlier WP3 acceptance claim is withdrawn; WP3 remains Blocked pending fresh independent QA.
- The repair adds a pre-spawn guard that checks every raw active-secret value unconditionally, then scans executable, every argument, cwd, workspace, request and cleaned environment keys/values, and the complete serialized request for repeatedly JSON-stringified representations. Only subsequent representations stop at the Rust v1 request-line byte limit; raw values are not exempt when they exceed that limit.
- Regression coverage includes the real macOS runner marker fixture, an injected-spawn no-execution fixture with quote/backslash input, the deepest representation that fits the v1 request-line limit, and an oversized raw active-secret argument. Rust, JSONL v1 fields, Runtime contracts, and cancellation semantics remain unchanged.
- This repair checkpoint is implementation evidence only until the architect reopens the gate and the test agent reproduces the original nested fixture with no spawn and no marker. Windows 11 remains Pending; G2, Shell Auto, and Shell Auto Debug remain unchanged.

## 2026-08-12 Windows 11 non-admin deterministic seam repair checkpoint

- On the current Windows 11 Pro x64 non-Administrator session, the Pi resource-isolation fixtures no longer require file-symlink creation privileges: the real hostile workspace uses a directory junction, while the file-symlink `AGENTS.md` contract runs through Candy's injected filesystem seam and remains fail-closed. The tests still assert that `.pi` resources are neither discovered nor executed, symlinked context is rejected, and credential canaries do not enter requests or sessions.
- `resolveNativeProcessRunnerPath` now honors a valid absolute `CANDY_SANDBOX_RUNNER` override before decoding the module URL, rejects relative or missing overrides without fallback, and resolves module/file URLs and candidate paths with the target platform's Windows or POSIX semantics. The native runner remains fail-closed for unsupported, relative, and missing paths.
- With a clean `npm ci --ignore-scripts` and Node `22.23.2`/npm `10.9.8`, checkpoint validation passed: `npm run check:toolchain`, `npm run check` (126/126 tests), `npm run check:native`, `npm run smoke:native:windows`, `npm run smoke:tui-task`, and `npm run smoke:app-server`.
- No real provider credential, external tool configuration, session, source upload, or public provider request was used. This is Windows deterministic implementation evidence only; true file-symlink/other reparse, OS-level network/workspace containment, signing, complete recovery/UI, Browser input-origin, live-provider, and final ACC-01..12 acceptance remain open.

## 2026-08-12 Windows 11 current-HEAD acceptance regeneration

- On clean current HEAD `b7cab12a8ecfd18d46c2813653e19dd978143ee4`, the verified local Electron `43.2.0` Windows x64 runtime was selected through `ELECTRON_OVERRIDE_DIST_PATH=D:\candy\out\electron-dist`; the packaged development bundle remained explicitly unsigned.
- `npm run acceptance:windows` passed all 22/22 steps with Node `v22.23.2`, npm `10.9.8`, Electron `43.2.0`, and lockfile SHA-256 `929848f85b3b11cc362c727848c8a2319d9771d9ff4780044a9333b829c57944`. The sanitized report is `out/acceptance/windows/latest.md` (gitignored); the responsiveness report is `out/acceptance/windows/responsiveness-latest.md`.
- The ten-run Windows subset records TUI/Desktop p95 `905/1370 ms`, Runtime projection `1 ms`, cancellation-to-process-tree termination `12 ms`, Browser Take Control `1 ms`, and renderer frame-gap `17 ms`, with no event-loss run. Packaged Browser action/security, recovery, handoff, coding journey/transcript, and Credential Manager synthetic fixtures passed.
- This is current-HEAD Windows deterministic and packaged-development evidence, not a complete V1 acceptance claim. Unsigned Desktop installation, true file-symlink/other reparse and OS-level G2 containment, physical Browser input-origin, full recovery/UI/ACC-12, live MiniMax/Token Plan, signing, and product-owner acceptance remain blocked or incomplete. No real provider credential or other tool configuration was read or used.

## 2026-08-13 Windows Personal Preview WP1-WP3 implementation checkpoint

- Added the narrow Pi `0.84.1` Bash adapter. It reuses `createBashToolDefinition()` and `noTools: "builtin"`, never calls Pi's local Bash backend, fixes Windows execution to `C:\Program Files\Git\bin\bash.exe --noprofile --norc -c <command>`, and delegates the process to Candy's Native Process Runner with the allowlisted child environment and `exposeSessionEnvironment: false`.
- Added explicit Personal Preview Shell task state and approval projection. The Desktop checkbox is opt-in and Auto-only; every command approval shows bounded command/cwd/timeout fields; deny, cancel, timeout, stale approval, restart, and credential-shaped command paths fail closed without replay.
- Enforced the Git Task Worktree boundary before Worktree creation and during approval/execution. Non-Git workspaces are rejected before creating a Worktree; Local Workspace never receives the Trusted Shell tool; existing review, Apply, and Discard handoff behavior remains unchanged.
- Deterministic verification passed: TypeScript build and `scripts/run-tests.mjs` passed **136/136**. Evidence is recorded in `docs/evidence/windows-personal-preview-2026-08-13.md`.
- The required fixed Git Bash executable is absent on the current host, so live Shell execution is intentionally blocked by fail-closed behavior. This checkpoint does not claim live Provider evidence, Windows Release Pass, complete G2, or final V1 acceptance.

## 2026-08-13 Windows Personal Preview WP4-WP5 evidence

- Windows native and packaged dogfooding passed after the Personal Preview changes: native Job Object smoke, app-server/TUI/Desktop smoke, recovery, long-running cancellation, attachment recovery, cross-client fencing, three-slot concurrency, unsigned packaged Desktop recovery/handoff/long-running/credential-isolation/coding-journey/Browser/Credential Manager smokes, and the responsiveness subset.
- `npm run acceptance:windows` passed **22/22**. The latest responsiveness report records TUI/Desktop p95 `1161/1365 ms`, Runtime projection `1 ms`, cancellation `16 ms`, Browser `1 ms`, and concurrent frame-gap `21 ms`.
- The unsigned Desktop package was built with the verified Electron `43.2.0` runtime. This is a Personal Preview artifact, not a signed Windows release.
- The fixed Git Bash path remains absent on the host, so no live Pi Bash command or real Provider credential was used. The preview remains fail-closed and must not be described as complete G2 or Windows Release Pass.

Windows 11 x64 implementation and acceptance now continue on the current Windows 11 Pro x64 host. The deterministic ten-run Windows ACC-12 subset is complete; the full ACC-12 matrix and the current macOS Tahoe 26.x primary matrix remain required for the final cross-platform V1 release claim. Exact `26.5.2` compatibility is tracked by the separate baseline runner. See `G0-WIN` in `docs/implementation/blockers-v1.md` for the active checklist.

## 2026-08-11 Windows release packaging pipeline checkpoint

- Added `package:desktop:windows:release` (`scripts/package-desktop-windows-release.mjs`) and `verify:desktop:windows:release` (`scripts/verify-windows-release.mjs`). The packaging path builds the unsigned bundle, embeds the release `candy-sandbox-runner.exe`, writes an MSIX layout with identity `Candy.V1`, `AppxManifest.xml`, and PNG assets, signs every `.exe`/`.dll` with `signtool /fd SHA256 /sha1`, packs and signs the MSIX, verifies with `signtool verify /pa /all`, and writes `release-metadata.json` (version, publisher, thumbprint, source revision, lockfile SHA-256, signed file list). The verify path drives install -> upgrade -> rollback -> uninstall while preserving an app-data marker across every phase, with authenticode validation and `Candy.exe` startup checks. Both scripts fail closed without the verified Electron override and the approved `CANDY_SIGN_CERT_THUMBPRINT`.
- `node --check`, Prettier, and `git diff --check` pass on Windows 11 Pro x64. Signed packaging remains Blocked: no certificate with the Code Signing EKU and a private key exists in the current-user or local-machine stores, and no PFX, signing env var, or Azure Trusted Signing configuration is available on this host; the release script therefore stops before producing a package.
- The MiniMax gate re-ran at source revision `07ed455` with the Token Plan entitlement confirmed by the product owner, but the Candy-owned `minimax-token-plan` credential is absent from Windows Credential Manager and no temporary env credential is set, so `LIVE-MM-01..05` remain Blocked (0 ms, no network request). The sanitized report is `out/acceptance/live/minimax-cn-latest.md`.

## 2026-08-11 Windows acceptance regeneration checkpoint

- `npm run acceptance:windows` passed 19/19 deterministic steps on clean revision `b1c88f7a9628c56f081382d054e00b49bb4cd3cc` with Node `v22.23.2`, Electron `43.2.0` (verified local Windows x64 distribution), and the pinned lockfile. Sanitized reports: `out/acceptance/windows/latest.md` and `out/acceptance/windows/responsiveness-latest.md` (both gitignored). TUI cold start p95 is `803 ms` (target `<= 2000 ms`) and Desktop cold start p95 is `1004 ms` (target `<= 5000 ms`).
- This is a deterministic regeneration, not a live-provider, signed-install, Browser physical-input, G2 OS-containment, complete ACC-01..12, or product-owner acceptance run. Those gates remain Blocked/In progress exactly as recorded in `blockers-v1.md`.

## 2026-08-11 Windows ACC-12 deterministic responsiveness checkpoint

- Extended `measure:windows:responsiveness` from cold-start-only coverage to the same ten-run Desktop seams already measured on macOS: Runtime event to visible renderer projection, user cancellation to task-owned process-tree termination, explicit Browser Take Control to rejected agent action, and three concurrent tasks with renderer frame-gap/event-delivery checks. The fixture now runs under a Candy-owned temporary app-data root (`CANDY_APP_DATA_ROOT`) on Windows, with the same isolated HOME/USERPROFILE/TEMP/APPDATA/LOCALAPPDATA and a loopback-only browser fixture; no Provider, Keychain value, or public network request is used.
- `resolveDefaultAppDataRoot` now honors an explicit `CANDY_APP_DATA_ROOT` override (platform-correct resolution), and the Desktop responsiveness launch forwards that override to the app-server child so both processes share the isolated Candy-owned store. A platform unit test covers the win32/darwin override.
- The ten-run Windows report at source revision `0f494a7` records: TUI cold start p95 `798 ms` (target `<= 2000`), Desktop cold start p95 `991 ms` (target `<= 5000`), Runtime projection p95 `1 ms` (target `<= 200`), cancellation to process-tree termination p95 `26 ms` (target `<= 5000`), Browser Take Control p95 `3 ms` (target `<= 500`), and three-task renderer frame gap p95 `21 ms` (target `<= 1000`) with `9/9/9=>9/9/9` projection delivery in all ten runs and zero event loss. Sanitized report: `out/acceptance/windows/responsiveness-latest.md`.
- This closes the previously missing Windows deterministic ACC-12 sub-metrics. Real-Provider stream-stop latency, Provider first-token/completion latency, public-network behavior, and the remaining complete UI/recovery ACC-12 evidence stay outside this fixture; those remain Blocked as recorded.

## 2026-08-11 Windows packaged Browser adversarial checkpoint

- `scripts/smoke-browser-windows.mjs` now mirrors the macOS adversarial fixture: the loopback page contains inert prompt-injection text plus a trap button, a slow/fast same-revision navigation race endpoint, a redirect/download endpoint, and a page sentinel. The smoke sets `CANDY_BROWSER_ADVERSARIAL=1` and runs the packaged Windows app under an isolated Candy-owned app-data root; the Desktop app-server child inherits `CANDY_APP_DATA_ROOT` so the whole run stays inside the temporary fixture.
- The packaged Windows fixture passes: prompt-injection text observed as untrusted content with the trap never auto-triggered, same-revision `race-slow`/`race-fast` navigation accepting exactly one revision-fenced request (slow wins, one revision consumed), a conflicting action invalidated by an explicit Take Control transfer, and all prior allowlist/action/selector/screenshot/popup/permission/download/redirect checks. After exit the page sentinel is absent from packaged stdout/stderr, app-server JSONL stdout (the `browserSmokeMarkerSeen` guard), and the Candy-owned session/state/attachment/worktree data tree; only the browser profile and Chromium partition caches retain page data by design.
- This is deterministic no-provider evidence on Windows 11 Pro x64. Physical input-origin detection, live Provider/session/protocol propagation, and the complete ACC-09/ACC-12 Browser matrix remain Blocked; automatic takeover is still not claimed.

## 2026-08-11 Windows Sandbox Runner launch TOCTOU hardening checkpoint

- The Windows native runner now canonicalizes workspace, cwd, and executable before launch, then re-canonicalizes all three after `CreateProcessW` resolves them and compares identities (`same_windows_path`) before `ResumeThread`. If any path was swapped to a different target or reparse point between the pre-flight check and launch, the suspended process and its Job Object are terminated and the runner returns `reparse_forbidden`/`invalid_path`. The executable validation rejects missing executables and executable files that are symlinks/reparse points, without rejecting legitimate junction ancestors used by toolchains such as `C:\nvm4w`.
- The Windows native smoke now also proves: a missing absolute executable is rejected with `invalid_path` before launch, and a child that writes 2 MiB to stdout is terminated/captured with output bounded at 1 MiB. Existing Job Object ownership, descendant cancellation, protocol network rejection, workspace escape rejection, and junction reparse rejection remain passing.
- `cargo test --locked` passes 3/3, `npm run check:native` passes, `npm run smoke:native:windows` passes, and the full `npm run check` passes 98 tests on Windows 11 Pro x64. This closes the pre-resume launch TOCTOU window and adds reproducible negative fixtures. OS-level no-network containment for arbitrary commands, runtime reparse/race protection after the process resumes, packaged/signed runner evidence, and the independent security review remain Blocked; Shell Auto and Shell Auto Debug stay disabled.

## 2026-08-11 Windows packaged long-running approval/steering checkpoint

- Added `scripts/smoke-desktop-packaged-long-running-windows.mjs` and `smoke:desktop:packaged:long-running:windows`, and added the step to `npm run acceptance:windows`. The packaged Windows app runs under an isolated Candy-owned app-data root with the packaged Node and native runner; the deterministic engine raises `approval_required`, the smoke waits for `waiting_approval`, sends `task.steer` (`steer-next-turn`), approves with the snapshot `approvalId`, and the validator-only loop completes with `validator-pass`.
- The fixture asserts the completed snapshot carries the final `evidenceSummary` containing `validator-pass`, the renderer projects the completed status, final evidence, and the steered transcript, and the validator marker records exactly two invocations (first fails, second passes). The step passed on Windows 11 Pro x64.
- `npm run acceptance:windows` now passes 20/20 deterministic steps. Remaining F items are the real-Provider stream-stop latency, signed-package evidence, OS-level containment, and independent security review; those remain Blocked and Shell Auto / Shell Auto Debug stay disabled.

## 2026-08-11 Windows packaged renderer credential-isolation checkpoint

- Added `CANDY_DESKTOP_CREDENTIAL_SMOKE` to the Desktop main process and `smoke:desktop:packaged:credential-isolation:windows`. The packaged Windows app runs under an isolated Candy-owned app-data root; the trusted main process writes a fixture value into the empty `minimax-cn` Credential Manager account, then the sandboxed renderer attempts `has`, key enumeration, and property-name enumeration over `window.candy.credentials`. None of the read attempts can observe the complete value, and the main process deletes the fixture afterwards and asserts `absent`.
- The fixture value is asserted absent from the packaged process stdout/stderr, and the smoke passed on Windows 11 Pro x64. This closes the packaged Windows renderer readback gap for ACC-02 as deterministic evidence; the signed Desktop path, the user-authorized DeepSeek account mutation window, and the live MiniMax Gate remain Blocked.
- `npm run acceptance:windows` now passes 22/22 deterministic steps at source revision `c8dd639` with a clean worktree, including the packaged credential-isolation step, the packaged long-running approval/steering step, and the packaged coding-journey/reopened-transcript step. Sanitized report: `out/acceptance/windows/latest.md`.

## 2026-08-11 Windows task transcript persistence and packaged coding journey checkpoint

- SQLite task metadata schema is now v10 with a `task_transcripts` table. The app-server persists bounded transcript entries (`user` prompt/steering, `assistant.delta`, `tool: validator ok/error`) and every snapshot carries the restored transcript; protocol validation bounds entries to 1024 items and 4096 chars each without NUL. Desktop projections initialize from snapshot transcript, so reopening Candy after an app-server restart shows the completed conversation.
- Fixed a real Desktop restart race: the old app-server child's `exit` handler could clear the newly started child; it now only clears the child it owns. Added unit coverage for schema/transcript persistence, protocol snapshot validation, and app-server transcript restoration across controller restart (101 tests pass).
- Added `CANDY_CODING_JOURNEY_SMOKE` to the app-server (deterministic editing engine that changes README.md and creates new.txt in the Task Worktree, streams assistant text, and completes after the validator) and `smoke:desktop:packaged:coding-journey:windows`. The packaged Windows fixture creates a Git workspace, runs create -> stream -> edit -> validator -> diff review -> Apply, verifies Local has the uncommitted tracked change and untracked file with the Git index untouched and no commit created, restarts the app-server, and asserts the reopened snapshot restores the full user/assistant/tool transcript.
- The new step is included in `npm run acceptance:windows` (now 22 steps). This is deterministic no-provider evidence for the ACC-03 core journey (reopen transcript), ACC-05 session/ownership subset, ACC-08 Apply (uncommitted, index untouched), and ACC-11 data preservation. Live DeepSeek/MiniMax ACC-03/04 contracts, signing, G2 OS containment, and product-owner review remain Blocked.

## 2026-08-12 Windows ACC-11 storage-integrity fixture checkpoint

- Added deterministic `SQLiteTaskStore` fixtures for the ACC-11 storage-failure surface: unknown future schema (`PRAGMA user_version = 11`) is rejected with a clear unsupported-schema error and the database handle is closed before throwing (fixes a Windows file-lock leak); a corrupted database file fails closed without overwriting the file; file-level backup/restore (copying DB/WAL/SHM) preserves task metadata, transcript, and run evidence; and an unopenable storage path fails closed without mutating the existing file.
- `npm run check` now passes 105 tests (was 101). The corrupted-database fixture uses asynchronous cleanup so the event loop can release the SQLite finalizer on Windows. This fills the previously missing ACC-11 backup/restore, unknown-schema, corrupted-data, and storage-failure fixture surface. Disk-full behavior is covered as the controlled storage-open failure class; a real full-disk fixture remains environment-dependent and is recorded as such.

## 2026-08-12 Windows non-Git workspace review checkpoint

- Added `NonGitWorkspaceChangeTracker`: at task creation it captures a recursive file snapshot (relative path, size, mtime) for non-Git workspaces, and after the turn it reports added/changed/removed relative paths as the review surface. Unreadable directories and entries are skipped instead of failing create; `node_modules`, `target`, `dist`, `out`, `build`, `.git/.hg/.svn` are excluded from the review snapshot to keep task creation fast and avoid dependency churn.
- The app-server default change tracker is now `ResolvedWorkspaceChangeTracker`, which uses Git review when a Git baseline exists and non-Git review otherwise. The `workspace.changes` event carries `available: true` with the non-Git changed-file list; Desktop projects the same changed-files/diff UI. Git review behavior is unchanged.
- Added runtime and app-server tests proving added/changed/removed detection and the full non-Git task journey. `npm run check` now passes 107 tests. This closes the ACC-08 non-Git change-review gap as deterministic evidence; non-Git Apply remains review-only (no patch contract), matching the product's Git-Apply scope.

## 2026-08-12 Windows Browser download policy checkpoint

- The Desktop Browser now implements the ACC-09 download contract instead of pure default-deny: `will-download` records a visible `denied` state and prevents the download unless the renderer explicitly confirms the exact URL (`browser.allowDownload`) for an already-allowed site. Confirmed downloads are saved under the Candy-owned app-data `downloads/` directory with a sanitized filename, tracked through `BrowserDownloadState` (denied/completed/failed, URL, filename, target path, bytes) exposed via `browser.downloads()` and `browser.downloads` events; nothing is auto-opened and downloaded bytes never enter the attachment store, session, protocol, or model context.
- The packaged Windows Browser smoke now asserts: the initial download is default-denied with a visible state; `allowDownload` completes the same fixture URL into the Candy downloads directory; the file content matches the fixture and never contains the untrusted page marker. `npm run check` stays green at 107 tests. This closes the ACC-09 download-visible/configured-path/no-auto-open subset; automated upload remains unavailable and physical input-origin detection remains Blocked.

## 2026-08-12 Windows provider isolation checkpoint

- Added an app-server fixture proving ACC-06 provider isolation: a DeepSeek task that throws a provider error (`provider_error` after `ProviderContractError`) does not block a concurrently running MiniMax task; the MiniMax task completes, writes its local file, and the local read succeeds while the DeepSeek task is surfaced as an actionable `provider_error`. The engine records both model calls.
- `npm run check` now passes 108 tests. This is deterministic evidence that provider failure classification and task scheduling keep DeepSeek rate limiting isolated from MiniMax and local reads; real cross-provider concurrency under live rate limits and the full dual-platform matrix remain Blocked.

## 2026-08-12 Windows TUI/Desktop shared app-data checkpoint

- Fixed an ACC-05 cross-client defect: the Desktop app used Electron's default `userData` (`%APPDATA%\Candy` on Windows) while the TUI and app-server used `resolveDefaultAppDataRoot()` (`%LOCALAPPDATA%\Candy`), so TUI and Desktop did not read the same Candy-owned task/session root. `startDesktop` now resolves `userData` from `CANDY_APP_DATA_ROOT ?? resolveDefaultAppDataRoot()`, making Desktop, TUI, and the app-server share the same Candy-owned app-data root by default while keeping the explicit override for fixtures.
- `npm run check` stays green at 108 tests and the development Desktop smoke (`npm run smoke:desktop`, no override) passes on Windows 11 Pro x64. This closes the ACC-05 same-session path seam as code evidence; a cross-client TUI/Desktop restart handoff on both platforms and full ACC-05 recovery remain open.

## 2026-08-10 Windows 11 deterministic worktree checkpoint

- The current development host is Windows 11 Pro x64. After a clean `npm ci --ignore-scripts`, the complete deterministic gate passes: format, lint, typecheck, 88 tests, protocol boundaries, exact Pi closure, and lifecycle policy. The durable TUI task and app-server JSONL smokes also pass under Node `22.23.2`.
- `resolveDefaultAppDataRoot` now selects `path.win32` or `path.posix` from the requested target platform rather than leaking the host separator into simulated macOS or Windows paths.
- `GitWorktreeManager` now parses NUL-delimited `git worktree list --porcelain -z` records, canonicalizes the recorded worktree path, and requires the exact lock reason. It no longer accepts a substring match from an unrelated worktree.
- Windows workspace-boundary coverage uses a directory junction, which is available to a normal Windows user session, and confirms the Pi tool host rejects traversal into the junction target. Real Git task creation, Apply, discard, and restart handoff fixtures now pass on Windows.
- This closes no acceptance Gate by itself. Windows Job Object containment, broader reparse-point fixtures, packaged Desktop/Keyring, signing, recovery, Browser, live providers, and ACC-12 remain open.

## 2026-08-11 Windows Job Object checkpoint

- The Windows native runner now creates validator processes suspended, assigns the direct process to a Job Object before resume, enables `KILL_ON_JOB_CLOSE`, bounds stdout/stderr, and terminates any remaining task-owned descendants after the direct process exits.
- The Windows smoke covers normal completion, protocol-level `network:true` rejection, workspace escape rejection, real directory-junction reparse rejection, and cancellation of a parent plus delayed descendant. The app-server selects the `.exe` runner and Windows validator path when a native binary is available.
- `npm run check` passes 93 tests plus boundary, Pi graph, and lifecycle checks; `npm run check:native`, `npm run smoke:native:windows`, `npm run smoke:tui-task`, `npm run smoke:app-server`, and Electron development `npm run smoke:desktop` pass on Windows 11 Pro x64 with Node `22.23.2`.
- This is a partial G2 implementation checkpoint, not a security or acceptance pass: protocol rejection does not prove OS-level no-network; arbitrary-command workspace containment, runtime reparse/race prevention, packaged/signed runner evidence, and independent security review remain open. Shell Auto and Shell Auto Debug remain disabled.

## 2026-08-11 macOS Task Worktree canonical-path checkpoint

- `GitWorktreeManager` now uses a native `realpath` canonicalization seam for association checks, so macOS Git output under `/private/var` matches Candy paths created through `/var`. The lexical Candy-owned Worktree root containment check and exact `candy:<task-id>` lock-reason comparison remain fail-closed and unchanged in policy.
- Cross-host Windows association fixtures now inject `path.win32` into the same seam, including case normalization, so they do not accidentally exercise the macOS host's POSIX path rules. A macOS-only alias regression and the real Git create/discard/apply fixtures cover both boundaries.
- The pinned macOS runner on `26.5.2` arm64 completed 9/9 steps on clean published revision `91f4f12d3d6b92d2d657d341ff14c14ef3482369`: `check:toolchain`, `check`, `check:native`, safe-edit, TUI, TUI task, app-server, Electron, and packaged Desktop/Keychain smoke. The deterministic suite passed 94 tests; no live provider command or external-tool credential was read.
- This restores the deterministic macOS Worktree baseline but does not close Runtime/session-remap, ACC-12 ten-run responsiveness, full recovery, Browser adversarial, Apple signing/notarization, live-provider, native containment/security-review, or final ACC-01..12 gates. Shell Auto and Shell Auto Debug remain disabled.

## 2026-08-11 macOS Runtime/session-remap checkpoint

- Added `smoke:runtime-session-remap` to the macOS acceptance sequence. It creates a real Pi `SessionManager` session under a temporary Candy app-data sessions root, recovers the persisted prompt through the Runtime recovery path with a different existing workspace, reloads the same session identity, and proves the JSONL history is unchanged and no second session is created.
- The smoke passed on macOS `26.5.2` arm64 with Node `22.23.2` and no provider request or credential access. Published revision `a13e6e8376ae93284abf3829818b7e9e628ac97a` passed the clean expanded `npm run acceptance:macos` sequence 10/10, including the existing 94-test deterministic check and packaged Desktop/Keychain smoke.
- This proves the local macOS session-remap seam only. Cross-platform TUI/Desktop ownership handoff, process-restart recovery, ACC-12 ten-run timing, live providers, native security review, signing/notarization, Browser adversarial evidence, and final acceptance remain open. Shell Auto and Shell Auto Debug remain disabled.

## 2026-08-11 Windows Credential Manager checkpoint

- `npm run smoke:credential-manager:windows` exercised Candy's own `KeyringCredentialStore` through Windows Credential Manager using only synthetic fixture values. The empty `minimax-cn` account passed `absent -> present -> present -> absent` for set, replace, presence, and delete; the already-present DeepSeek account was observed by presence only and left untouched.
- No credential value, lease, provider request, renderer readback, or external-tool configuration was used. This is adapter/lifecycle evidence only; it does not close ACC-02 because the existing DeepSeek account was not mutated, the packaged Desktop path and canary write/commit/push guard remain unverified, and no real provider Gate was run.

## 2026-08-11 Windows responsiveness subset checkpoint

- Added a sanitized Windows measurement runner with ten repetitions for the deterministic TUI cold-start smoke and Electron development Desktop cold-start-to-task-list smoke. The current local report for source revision `aefa8ff27bd0a4f7a4cda0e73360695843e36fb8` records TUI p95 `1315 ms` against the `2000 ms` target and Desktop p95 `1529 ms` against the `5000 ms` target.
- The report is ignored under `out/acceptance/windows/` and records source revision, lockfile digest, Windows x64, Node `22.23.2`, and verified Electron `43.2.0` without provider or browser data.
- This is only an ACC-12 subset. Runtime-to-UI projection, cancellation, Browser Take Control, and three-concurrent-task responsiveness remain unmeasured; it does not close ACC-12 or any final acceptance claim.

## 2026-08-11 Windows unsigned packaged Desktop checkpoint

- `npm run package:desktop:windows` copied the user-verified Electron `43.2.0` Windows x64 runtime into the ignored `out/windows/Candy` bundle, renamed the executable to `Candy.exe`, and embedded Node `v22.23.2`, the built app-server, the Windows native runner, and the runtime dependencies. The generated metadata records `signing: unsigned`.
- `npm run smoke:desktop:packaged:windows` passed the packaged app-server JSONL snapshot/quit smoke. This is local unsigned development evidence only; it does not prove Windows signing, installation, recovery, Browser, native containment, or release acceptance.

## 2026-08-11 Windows packaged Credential Manager checkpoint

- Added a packaged Windows Node smoke that executes Candy's own `KeyringCredentialStore` through the embedded `resources/node/node.exe` and bundled keyring addon. The synthetic MiniMax account passes `absent -> present -> present -> absent`; the existing DeepSeek account is presence-only and unchanged.
- This is packaged adapter/lifecycle evidence without provider calls or credential output. Full ACC-02 still requires a user-authorized mutation window for the existing account and the signed Desktop path.

## 2026-08-11 Windows active-task recovery checkpoint

- Extended the real Windows app-server child-process smoke to create a queued task and an active Auto task with a Windows Job Object validator, interrupt the validator while it is running, verify its delayed marker is never written, stop the owner process, restart it, and verify queued metadata survives while the active task becomes `interrupted` with revision `+1` and bounded `crash_interrupted` progress.
- `npm run smoke:recovery:windows` passed without provider credentials. This proves Windows active validator interruption plus deterministic app-server owner-crash recovery; attachment restart recovery is covered by the follow-up fixture, while packaged signed recovery remains open.

## 2026-08-11 Windows attachment restart recovery checkpoint

- Added `npm run smoke:attachment-recovery:windows`. The Windows fixture writes a Candy-owned image attachment, persists a MiniMax task referencing its opaque id, stops the app-server, restarts it with the deterministic recovery engine, verifies the queued task and attachment id survive, and runs the task to completion after the restart. The fixture reads no provider credential and does not expose attachment bytes in protocol output.
- This closes the attachment restart seam and the packaged active-owner/tool interruption recovery seam. Packaged cross-client handoff remains open.

## 2026-08-11 Windows cross-client ownership checkpoint

- Added `npm run smoke:cross-client:windows`, which runs two real `AppServerController` owners over a shared Candy SQLite database on the Windows host. While owner-1 holds a running task, owner-2's cancel and run commands return the running snapshot with owner-1 intact; the owner-1 task then completes normally.
- This proves non-owner read-only fencing in the Windows control-plane fixture. Attachment recovery, cross-process packaged handoff, and complete Desktop recovery remain open.

## 2026-08-11 Windows bounded concurrency checkpoint

- Added `npm run smoke:concurrency:windows`, which runs four real app-server tasks on the Windows host with three held execution slots. The fourth remains queued, is promoted FIFO after the first slot is released, and all four complete while the measured active count never exceeds three.
- This proves the task-runtime concurrency bound and FIFO promotion on Windows. It does not measure renderer presentation freeze, event loss, provider latency, or the complete three-concurrent-task ACC-12 matrix.

## 2026-08-11 Windows packaged Browser Workspace checkpoint

- Added the narrow Desktop Browser bridge and visible `WebContentsView` path. Sites require an explicit host allow step; only HTTPS and loopback HTTP fixture URLs are accepted, the browser uses `persist:candy-browser-v1`, and the renderer receives only typed tab snapshots through preload IPC.
- The packaged Windows fixture smoke passed page observation, selector-scoped click/type/confirmed-submit, confirmation rejection, stale-revision rejection, user-owned action rejection, screenshot capture into Candy AttachmentStore, popup denial, permission denial, download prevention, disallowed redirect prevention, and explicit Take Control/return-to-agent revision transfer. Only a typed snapshot and opaque `att_...` screenshot id leave the trusted main process; no provider credential, browser profile, cookie, or authentication data was used.
- This remains a partial Browser Workspace checkpoint. Electron does not provide a claimed reliable physical input-origin signal here, so the accepted explicit Take Control fallback remains in force; adversarial page coverage and complete ACC-09/ACC-12 evidence remain open.

## 2026-08-11 Windows packaged Browser action checkpoint

- `npm run smoke:browser:windows` passed on the packaged Windows x64 bundle after the bridge added structured click/type/submit actions and screenshot attachment capture. The fixture proves action ownership and revision fencing: stale actions and actions after Take Control are rejected, unconfirmed submit is rejected, and confirmed submit updates the observed page state.
- This is implementation and fixture evidence, not a claim of automatic physical-input detection, full Browser adversarial coverage, or complete Browser acceptance.

## 2026-08-11 Windows packaged Browser adversarial boundary checkpoint

- The packaged fixture now also rejects non-loopback HTTP, URL credentials, script URLs, unauthorized hosts, malformed structured actions, missing selectors, non-field type targets, and non-submit targets. The existing redirect, popup, permission, download, stale-revision, owner, and confirmation checks remain passing.
- This closes only the deterministic URL/action/selector rejection subset. Physical input-origin detection, broader hostile-page behavior, and complete Browser/ACC-09/ACC-12 acceptance remain open.

## 2026-08-11 Windows user-cancellation and 18-step acceptance checkpoint

- Added `npm run smoke:long-running:windows`. A real Windows app-server task starts a long-running validator through the Job Object runner, receives `task.cancel` at revision `1`, reaches `cancelled` at revision `2` with bounded `cancelled` progress, and leaves no delayed validator marker after the descendant cleanup window.
- The smoke passed without provider credentials. It complements the existing active-validator interruption and owner-crash recovery evidence; Shell Auto and Shell Auto Debug remain disabled.
- On clean source revision `4abc88ab906edd66f0b77a707c248e2375c7640b`, `npm run acceptance:windows` passed all 18 deterministic steps on Windows 11 Pro x64 with Node `22.23.2` and verified Electron `43.2.0`. The run includes the new user-cancellation smoke, packaged recovery, Browser boundary fixture, Credential Manager fixture, bounded concurrency, and the ten-run responsiveness subset; p95 values are TUI `1180 ms` and Desktop `1435 ms`.
- Reports remain sanitized and ignored at `out/acceptance/windows/latest.md` and `out/acceptance/windows/responsiveness-latest.md`. This does not close signed installation, packaged cross-client handoff, complete Browser/G2/security evidence, live MiniMax/entitlement, full ACC-01..12, macOS, or product-owner acceptance.

## 2026-08-11 Windows packaged sequential cross-client handoff checkpoint

- Added `npm run smoke:desktop:packaged:handoff:windows`. Two separately spawned packaged Windows app-server processes share a Candy-owned SQLite database: the first owner pauses during a running validator, reaches `paused` revision `2` with no owner and no migrated validator; the second process restores that state, resumes at revision `2`, owns revision `3`, and produces the second sequential validator invocation before cancellation at revision `4`.
- This proves the packaged sequential pause/resume handoff and owner fencing seam without moving an in-flight tool between processes. It does not prove signed installation, complete Browser/G2 security, or the full Desktop/ACC acceptance matrix.

## 2026-08-11 Windows Browser hostile-selector boundary checkpoint

- The Desktop Browser action contract now rejects NUL-containing targets at the trusted bridge and the packaged fixture rejects an invalid CSS selector before any page action can proceed. Existing URL, action, selector, stale-revision, owner, confirmation, redirect, popup, permission, and download fail-closed checks remain passing.
- This narrows the deterministic hostile-input boundary only. Reliable physical input-origin detection, broader hostile-page behavior, and complete Browser/ACC-09/ACC-12 acceptance remain open.

## 2026-08-11 Windows 19-step deterministic acceptance runner checkpoint

- On clean source revision `7c2eb877b0a9262735623aa83016916bf0fcc997`, `npm run acceptance:windows` passed all 19 deterministic steps on Windows 11 Pro x64 with Node `22.23.2` and verified Electron `43.2.0`. The run includes user-cancellation cleanup, packaged restart recovery, packaged sequential cross-client handoff, Browser hostile-selector boundary fixture, Credential Manager fixture, bounded concurrency, and the ten-run responsiveness subset; p95 values are TUI `1185 ms` and Desktop `1432 ms`.
- The sanitized reports remain ignored at `out/acceptance/windows/latest.md` and `out/acceptance/windows/responsiveness-latest.md`. They keep signed installation, complete Browser/G2/security evidence, live MiniMax/entitlement, remaining ACC-01..12, macOS, and product-owner acceptance open; this is not a release or complete cross-platform acceptance report.

## 2026-08-11 Windows 17-step deterministic acceptance runner checkpoint

- `npm run acceptance:windows` ran on clean source revision `7043e286bbde645f4af7507504298234dd17011c` with Node `22.23.2`, verified Electron `43.2.0`, and the current Windows x64 host. All 17 deterministic steps passed: toolchain, full TypeScript check (93 tests), native check, Windows Job Object smoke, Credential Manager fixture, TUI task smoke, app-server smoke, active validator interruption plus queued/active process-restart recovery smoke, attachment restart recovery smoke, non-owner cross-client fencing smoke, bounded three-slot concurrency smoke, development Desktop smoke, unsigned packaged Desktop smoke, packaged active-owner/tool recovery smoke, extended packaged Browser action/adversarial security fixture smoke, packaged Credential Manager fixture smoke, and the ten-run responsiveness subset. The latest p95 values are TUI `1169 ms` and Desktop `1406 ms`.
- The sanitized reports are `out/acceptance/windows/latest.md` and `out/acceptance/windows/responsiveness-latest.md`; both remain ignored. They explicitly list signed installation, Browser physical input-origin and complete adversarial/acceptance coverage, complete G2 OS containment/security review, packaged cross-client handoff, live provider/entitlement, remaining ACC-01..12, and product-owner acceptance as open; this is not a release or complete acceptance report.

## 2026-08-10 Windows 11 live DeepSeek checkpoint

- The user-authorized local DeepSeek credential was written to Candy's own Windows Credential Manager path without printing or recording its value. The source configuration was not copied into the repository.
- `npm run gate:live:deepseek` completed all seven Windows scenarios: `LIVE-DS-01..04`, cancellation, controlled 401/429/timeout recovery, secret-free session scan, and secret-lease release. The runner used only `https://api.deepseek.com` and wrote a sanitized, ignored local report at `out/acceptance/live/deepseek-latest.md`.
- This advances the Windows DeepSeek Gate only. MiniMax, macOS repetition, packaging, Credential Manager lifecycle, and ACC-01..12 acceptance remain separate work.

## 2026-08-10 durable queued-task reorder checkpoint

- SQLite metadata now moves a queued task before another queued task inside an immediate transaction and stores contiguous queue positions. The reordered sequence survives reopening the Candy-owned database.
- Protocol v1 accepts `task.reorder { beforeTaskId }`. The app-server applies it only to pending queued run requests, persists the order before mutating its in-memory scheduler, and promotes the reordered task when the next of three execution slots becomes free.
- The TUI scheduler now binds to the persisted queue and exposes `:prioritize <task-id>` after `:tasks`; it prints each task's queue position. Resumed paused/interrupted tasks can re-enter the TUI drain loop, but cross-process resume and the Desktop task-list/queue panel remain separate work.
- Deterministic verification on the Windows 11 Pro x64 host passed format, lint, typecheck, 92 tests, protocol/boundary checks, exact Pi closure, and lifecycle policy. This does not close ACC-06: complete restart, multi-client, rate-limit, and dual-platform acceptance evidence remains required.

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

## 2026-08-11 macOS app-server and packaged recovery checkpoint

- Added `scripts/smoke-recovery-macos.mjs` with source and `--packaged` modes. Each mode isolates `HOME`/`TMPDIR` under a temporary fixture, starts the real JSONL app-server with the deterministic recovery engine, creates queued and active tasks, stops the owner, restarts the process, and verifies queued metadata plus the active task's `crash_interrupted` progress.
- The active task uses the real macOS Sandbox Runner validator path. The smoke confirms that owner shutdown cancels the validator process group and the delayed validator marker is not written. This is local deterministic descendant-cleanup evidence, not an OS containment or independent security-review result.
- Published commit `327b0e529f403a207941e0d9f28a3c2ba45c83d3` adds the source app-server and embedded packaged Node/app-server recovery commands to `npm run acceptance:macos`. On clean macOS `26.5.2` arm64 with Node `22.23.2`, the runner passed 12/12 steps and 94/94 tests; the sanitized report is `out/acceptance/macos/latest.md`.
- No provider credential, other tool configuration, live provider request, Apple signing identity, or notarization path was used. The report continues to classify full recovery/UI, Browser, native-security, signing, live-provider, and final ACC evidence as open.

## 2026-08-11 macOS ACC-12 cold-start measurement checkpoint

- Added `measure:macos:responsiveness`, a ten-run deterministic measurement for TUI cold start to the usable smoke prompt and Desktop cold start to the task-list smoke. It uses the pinned Node 22 runtime, local Electron 43.2.0, no provider request, and Candy's minimal child environment.
- On clean revision `a9237399ba103c77c345bcf1cfb2fc064a7fde09` and macOS `26.5.2` arm64, TUI p95 is `1199 ms` against the `2000 ms` target and Desktop p95 is `2064 ms` against the `5000 ms` target. The full macOS acceptance runner passed 13/13 steps with 94/94 tests.
- Sanitized reports are `out/acceptance/macos/latest.md` and `out/acceptance/macos/responsiveness-latest.md`. The measurement deliberately leaves Runtime-event-to-UI, cancellation, task-owned process-tree timing, Browser Take Control, and three-task freeze/event-loss metrics unmeasured; this is not complete ACC-12 or final V1 acceptance.

## 2026-08-11 macOS packaged Browser checkpoint

- Added `scripts/smoke-browser-macos.mjs` and included it in `npm run acceptance:macos`. The smoke uses a temporary Candy `HOME`/`TMPDIR` and a loopback-only HTML fixture; it never reads provider credentials or connects to a public site.
- The packaged macOS fixture passes explicit site allowlisting, typed click/type/confirmed-submit, malformed URL/action/selector rejection, stale revision rejection, screenshot attachment-id handoff, popup/permission/download/redirect default-deny, and explicit Take Control/return-to-agent fencing. macOS screenshot capture uses only the visible Browser Workspace bounds through `BrowserWindow.capturePage`; other platforms retain the existing webContents capture path.
- Clean revision `261bb346f12b6c28288a292db5bf77e26d531127` passes the full local macOS runner at 14/14 steps with 94/94 tests. This is deterministic packaged Browser evidence only; reliable physical input-origin detection, broader adversarial-page coverage, complete ACC-09/ACC-12, signed packaging, native-security review, and live-provider acceptance remain open.

## 2026-08-11 macOS packaged sequential handoff checkpoint

- Added `scripts/smoke-desktop-packaged-handoff-macos.mjs` and `smoke:desktop:packaged:handoff:macos` to the macOS acceptance sequence. The fixture starts two independent packaged Node/app-server owners against a temporary Candy app-data root and uses only a local validator fixture; it reads no provider credential, Keychain value, or other tool configuration.
- The first owner creates an Auto task, reaches running revision `1`, pauses it at revision `2` with `user_stop` and no owner. The validator fixture creates a delayed child process; the pause path waits for the process-group cleanup window and asserts that the child marker is absent before the first owner exits. The second packaged owner restores the paused revision, a stale revision `1` resume is rejected while the ownerless revision `2` remains persisted, and only an explicit resume starts a new turn at revision `3`; it observes the second validator invocation and cancels at revision `4`, again asserting no validator descendant marker remains. Validator invocations are sequential and no in-flight call is migrated.
- The expanded local macOS runner passes 15/15 deterministic/native/TUI/Desktop/recovery/handoff/Browser/responsiveness steps with the existing 94 tests on macOS `26.5.2` arm64. This is deterministic packaged handoff evidence only; complete cross-client UI/ACC-05 recovery, physical Browser input-origin, full ACC-12, signing, native-security review, live providers, and final acceptance remain open.

## 2026-08-11 macOS ACC-12 deterministic responsiveness checkpoint

- Extended `measure:macos:responsiveness` from cold-start-only coverage to ten repetitions of the real Desktop seams: Runtime event to visible renderer projection, user cancellation through the Desktop bridge to validator parent-and-descendant termination, explicit Browser Take Control to rejected agent action, and three concurrent tasks with renderer frame-gap/event-delivery checks.
- On macOS `26.5.2` arm64 with Node `22.23.2` and Electron `43.2.0`, the full `acceptance:macos` run passed 15/15 steps; the post-push report at source revision `d9a0fe2` records TUI/Desktop cold-start p95 `983/2053 ms`; Runtime projection p95 `2 ms` (target `<=200 ms`), process-tree termination p95 `12 ms` (target `<=5000 ms`), Take Control rejection p95 `2 ms` (target `<=500 ms`), and concurrent renderer frame-gap p95 `19 ms` (target `<=1000 ms`). All ten concurrency runs delivered `9/9/9=>9/9/9` projections with no event-loss run.
- The fixture is Candy-owned, temporary, local, deterministic, and provider/Keychain-free. The sandboxed renderer preload now uses a CommonJS `.cts` output so the measured `contextBridge` projection path is actually present; smoke-only credential presence refresh remains disabled to avoid Keychain access. The explicit Take Control fallback is measured; no physical-input auto-takeover is claimed.
- This is measurable local evidence only, not complete ACC-12 or V1 acceptance. User cancellation to real Provider stream-stop remains Blocked, as do Provider latency, public-network behavior, full UI/recovery evidence, Windows parity, signing, native security review, live providers, and product-owner acceptance. Shell Auto and Shell Auto Debug remain disabled.

## 2026-08-11 macOS packaged Browser adversarial checkpoint

- On source revision `951283bd4c8f3c0ae8778ab50bd6ed4044f436e7`, `npm run smoke:browser:macos` passed against the packaged Electron `43.2.0` / Node `22.23.2` app on macOS `26.5.2` arm64. The temporary loopback fixture contains explicit prompt-injection text and a trap action; observation treats the text as untrusted content and the trap remains inactive without an explicit selector action.
- The Browser main-process mutation lane now serializes open/navigate/action/observation/screenshot operations. A packaged renderer IPC race with two same-revision slow/fast navigations accepts exactly one request and consumes one revision; stale revisions, invalid/NUL/oversized or hostile selectors, URL credentials, disallowed redirects, popup, permission, and download attempts remain fail-closed. An explicit Take Control transfer invalidates the conflicting agent action and the user-owned action is rejected; screenshot handoff still returns only an opaque `att_...` id.
- The fixture marker is absent from packaged process output, app-server JSONL stdout, and the complete Candy-owned temporary app-data tree after exit. This is bounded deterministic no-provider evidence that the observed page text did not enter those Provider/session/protocol sinks; the smoke starts no Provider turn and does not claim live Provider propagation or physical-input origin detection.
- Electron does not provide a reliable physical input-origin signal in this path. The visible explicit Take Control fallback remains the only accepted ownership transfer, and no automatic takeover is claimed. Broader hostile-page/navigation variants, complete ACC-09/ACC-12, signed packaging, native-security review, and live-provider evidence remain open; Shell Auto and Shell Auto Debug remain disabled.

## 2026-08-11 macOS Sandbox Runner G2 negative matrix checkpoint

- On clean source revision `e6c03a2e80385b2ae9773bdc4c0c4691b40cbb2d`, `npm run smoke:sandbox:macos` passed on macOS `26.5.2` arm64 with Node `22.23.2`/npm `10.9.8`. The full `npm run acceptance:macos` also passed 16/16; the sanitized report is `out/acceptance/macos/latest.md`.
- The source-driven matrix proves that the TypeScript `WorkspaceGuard` rejects outside-workspace reads/writes and symlink reads/writes. It separately proves that the raw macOS runner can read and write outside the workspace, follow a workspace symlink for reads/writes, and complete a post-`lstat` symlink swap into an outside directory. These native escape results are expected under the current Seatbelt `(allow default)` profile and mean OS-level workspace containment is **not proven**; `WorkspaceGuard` is policy validation, not OS isolation.
- The same runner blocks a local loopback network connection and cancels a detached descendant process group; the delayed descendant marker remains absent after the cancellation window. These are bounded no-network and process-ownership observations, not a complete native security review.
- No Rust/Seatbelt change was made because the matrix did not demonstrate a stronger OS boundary. The remaining workspace containment/race design, packaging/signing verification, and independent security review are `Blocked`; Shell Auto and Shell Auto Debug remain disabled. No live provider, credential, session, or external-tool configuration was used.

## 2026-08-12 macOS packaged Browser smoke isolation regression fix

- Reproduced `npm run smoke:browser:macos` from `b516739`: the packaged Browser journey itself completed, but the final recursive marker scan treated expected rendered-page retention in Electron's persistent Browser Profile/Partitions as a session or protocol leak.
- `scripts/smoke-browser-macos.mjs` now launches the packaged app with temporary `HOME`/`TMPDIR` values and an explicit temporary Candy-owned `CANDY_APP_DATA_ROOT`. The smoke continues to scan stdout, stderr, the app-server JSONL path, and Candy-owned `sessions`, `state`, `attachments`, `worktrees`, and `downloads` data for the page marker.
- Only the `browser-profile` and `Partitions` directories are excluded from the page-content scan because they are expected local Browser Profile persistence. This is not a session, state, attachment, worktree, downloads, stdout/stderr, or protocol exemption; site allowlisting, sensitive-operation confirmation, Take Control, download policy, prompt-injection, and marker assertions are unchanged.
- The fixed `npm run smoke:browser:macos` passes on macOS `26.5.2` arm64 with Node `22.23.2` and packaged Electron `43.2.0`. This closes the deterministic smoke regression only; complete `ACC-09`, physical input-origin evidence, broader adversarial coverage, signing, native security review, live providers, and final V1 acceptance remain open.

## 2026-08-12 macOS packaged Desktop credential and coding-journey checkpoint

- Added `smoke:desktop:packaged:credential-isolation:macos` and `smoke:desktop:packaged:coding-journey:macos` to the serial macOS acceptance runner. Both launch the packaged app with temporary `HOME`/`TMPDIR` and an explicit temporary `CANDY_APP_DATA_ROOT`; no real provider credential, Keychain value, other tool configuration, or live Provider request is used.
- The credential fixture uses an in-memory Candy store with a synthetic value and drives the sandboxed renderer's set/presence/delete bridge. Renderer presence and property enumeration never expose the complete value, the fixture is deleted back to `absent`, and the synthetic value is absent from packaged output. The existing packaged Keychain lifecycle fixture remains separate and does not overwrite an existing user account.
- The coding-journey fixture creates a temporary Git workspace, runs the packaged create -> streamed assistant output -> edit -> validator -> diff review -> Apply path, verifies the Local workspace has the tracked and untracked changes with the Git index and `HEAD` unchanged, then restarts the packaged app-server and verifies the bounded user/assistant/tool transcript reopens. This is deterministic no-provider evidence for the core coding journey, Apply, and transcript-reopen subset.
- `npm run acceptance:macos` passed `20/20` on macOS `26.5.2` arm64 at source revision `86242138a7530656962c67f45e10ce59b8d16256`, with Node `22.23.2`, npm `10.9.8`, Electron `43.2.0`, and `npm run check` passing `108/108` tests. The ten-run responsiveness subset records TUI/Desktop p95 `545/1253 ms`, Runtime projection `0 ms`, cancellation to process-tree termination `13 ms`, Browser Take Control `1 ms`, and concurrent frame-gap `19 ms`; all 20 acceptance steps passed.
- This closes the current deterministic macOS packaged Desktop slice only. Live DeepSeek/MiniMax contracts, Apple/Windows signing, OS-level workspace containment and independent security review, physical Browser input-origin, complete ACC-09/ACC-12 UI/recovery evidence, Windows parity, and final V1 acceptance remain open; Shell Auto and Shell Auto Debug stay disabled.

## 2026-08-12 macOS strict Seatbelt containment repair checkpoint

- The fail-first macOS native smoke initially rejected the old `(allow default)` behavior by requiring a supported validator to succeed and requiring outside-workspace read/write, symlink read/write, and post-`lstat` symlink-swap probes to be blocked. The old implementation failed those new assertions before the native repair.
- The macOS runner now canonicalizes workspace, cwd, and executable paths, rejects a canonical cwd outside the workspace, rejects profile-path control characters, and launches the canonical executable under a default-deny Seatbelt profile importing `system.sb`. The profile denies network access, permits only the exact validator executable and its runtime reads, and permits workspace reads/writes plus the minimal parent metadata needed for `/private`, `/private/var`, `/private/tmp`, and `/private/var/folders`. Windows Job Object code was not changed.
- The native matrix now passes supported-validator execution, outside read/write denial, symlink read/write denial, symlink-swap denial, loopback network denial, and detached-descendant cancellation. Runtime coverage rejects provider-shaped credentials before the runner request and proves a provider-shaped child environment value is absent. Packaged responsiveness, handoff, and long-running fixtures were corrected to keep their validator state markers inside the task workspace.
- `cargo test --locked` passes 5/5, `npm run check:native` passes, `npm run check` passes 109/109 tests, and `npm run acceptance:macos` passes 20/20 on macOS `26.5.2` arm64 with Node `22.23.2`, npm `10.9.8`, and Electron `43.2.0`. The ten-run responsiveness report records TUI/Desktop p95 `562/2042 ms`, Runtime projection `1 ms`, process-tree termination `13 ms`, Browser Take Control `2 ms`, and concurrent frame-gap `19 ms` with no event loss.
- This is a macOS containment repair checkpoint only. It does not complete G2 or release acceptance: independent native security review, signed/notarized packaging, Windows OS-level containment/parity, live-provider evidence, complete ACC-09/ACC-12 evidence, and final product-owner acceptance remain open. Shell Auto and Shell Auto Debug remain disabled.

## 2026-08-12 macOS live DeepSeek Provider Gate checkpoint

- On clean macOS `26.5.2` arm64 at source revision `7242b74f447f715ab1bd44ea684c63fefd74046b`, with Node `22.23.2` and npm `10.9.8`, `npm run build` passed and the only live command run was `npm run gate:live:deepseek`.
- The Gate used Candy's `candy-v1/deepseek` Keychain path with the approved endpoint `https://api.deepseek.com`; the invocation removed Candy temporary Provider variables and common non-Candy Provider variables. No other tool configuration or credential source was read or imported. MiniMax was not run.
- The sanitized report `out/acceptance/live/deepseek-latest.md` records `7 passed, 0 failed, 0 blocked`: `LIVE-DS-01` Flash text, `LIVE-DS-02` Flash thinking/tool replay, `LIVE-DS-03` Pro thinking/tool replay, `LIVE-DS-04-cancel`, controlled 401/429/timeout error contracts with recovery, `secret-free-session`, and `secret-lease-release`.
- The Gate report contains only presence, provider/endpoint, event summaries, durations, status, and sanitized contract classifications; it contains no credential value, length, fingerprint, authorization header, prompt, or raw Provider payload. The controlled error row is an in-process contract fixture, while the text/thinking/tool/cancellation rows are the live DeepSeek turn evidence.
- `npm run check` passed the deterministic suite at `109/109` after the live run. This closes the macOS DeepSeek provider matrix and updates `G0-LIVE-DS`/`G0-DS-ADAPTER`; it does not close MiniMax Token Plan evidence, signed/notarized packaging, G2 security review, Browser/ACC evidence, Windows release parity, or final V1 acceptance.

## 2026-08-13 TUI Task Worktree handoff checkpoint

- The source Personal Preview now has a root `npm run tui` launcher. For an Auto task in a Git repository, TUI creates and persists a Candy-owned locked Task Worktree before starting the model turn; prompt recovery, file tools, validator, change review, and continuation turns all use that execution path while the selected Local Workspace remains unchanged.
- TUI adds explicit `:apply` and `:discard`. Apply requires a completed ownerless task plus a current complete `:changes` manifest and full untruncated `:diff`, including text content for untracked files; binary untracked files remain fail-closed. It re-inspects and fingerprints the Worktree before transferring reviewed tracked and untracked changes as unstaged Local changes, then removes the Worktree. Discard resets and removes only the Candy-owned Worktree and leaves Local untouched.
- Task creation is serialized while baseline/Worktree preparation is active and shutdown waits for that bounded operation before closing SQLite, preventing input races or cleanup against a closed task store. `:tasks` now reports `workspace=local|worktree`.
- Apply security now blocks an active provider credential in reviewed paths, tracked patch text, or untracked file bytes. TUI leases both Candy-owned DeepSeek and MiniMax credentials only for local review/Apply checks, redacts rendered paths and patches, and releases both leases without persisting their values.
- The TypeScript and Rust native boundaries now distinguish Candy's `task-<id>` Worktree path from a standalone credential-shaped `sk-...` value while retaining exact active-secret checks and strict secret-bearing environment-key rejection. Full-diff rendering always ends on a line boundary so the following Apply result remains readable.
- `npm run check` passes `160/160`, Rust tests pass `6/6`, and the current macOS `26.6.1` arm64 real-PTY journey passes validator, complete review, Apply, restart, and terminal restoration. Shell and Shell Auto Debug remain disabled pending G2, and this checkpoint is not Windows, live-provider, signed-package, or final V1 evidence.
