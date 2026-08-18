# Candy V1 Blocker Register

Updated: 2026-08-18

Post-`9009ac1` current-host revalidation: macOS acceptance passes **14/14** with embedded deterministic `npm run check` at **247/247** on Node `22.23.2`/npm `10.9.8`, and the current strict macOS containment matrix passes. Code checkpoint `9009ac1` closes the four medium findings from standard scan `721c4ab5-ccdf-4052-9a28-b695323b3b70` at the source level (worktree/workspace/session descriptor-relative binding and Trusted Shell read-only direct-tool network policy with nested-interpreter rejection), with new regressions for each category. The external standard scanner could not be rerun in this session, so an independent scan rerun remains an evidence gate and this checkpoint is not a security clearance. Production Trusted Shell validation remains fail-closed until the macOS G2 decision is confirmed by an independent reviewer or the user. Live gates source-bound to `a523aa2` pass DeepSeek **7/7** and domestic MiniMax **8/8** with sanitized evidence; current-HEAD live reruns remain pending user authorization. Remaining personal macOS blockers are the independent scan rerun, macOS G2 approval, signing, and final personal acceptance. Windows execution is deferred for this work packet.

## 2026-08-18 Issue #4 `9009ac1` security hardening checkpoint

- Code checkpoint `9009ac1` is pushed and matches `origin/codex/candy-v1-foundation`. It adds no-follow directory-handle identity binding around every Git worktree operation, workspace read/write/mkdir/access/delete, and Pi SessionManager call; session files now resolve relative to the Candy session root; network elevation runs only read-only direct tools (`git ls-remote`, `curl` GET/HEAD, `wget` GET) without a shell or process-exec capability; nested-interpreter/executor publication forms are rejected before approval or spawn.
- `npm run check` passes **247/247**, `npm run check:native` passes, `npm run smoke:sandbox:macos` passes the strict matrix, and `npm run acceptance:macos` passes **14/14** on macOS `26.6.1` arm64 with `realPty=true`.
- This closes the four scan findings at the source level but is not an independent security clearance: the standard scanner was unavailable in this session. The independent scan rerun (target 0 open findings), macOS G2 confirmation, current-HEAD live gates, real Trusted Shell journeys, and final personal acceptance remain open. `.omo/` remains user-owned, untracked, and preserved.

## 2026-08-17 Issue #4 Windows real DeepSeek TUI journey checkpoint

- `smoke:tui:real-journey:windows` drives the production TUI composition root through the ConPTY bridge with the real Windows Credential Manager DeepSeek credential. The real provider turn mutates the workspace through `candy_write`, completes the task, and leaves the fixture tree credential-free at source revision `83d9887` on Windows 11 Pro x64.
- This closes the Windows live ACC-03 core coding journey evidence. The MiniMax Windows live Gate, the existing-account Credential Manager lifecycle, the Developer-Mode reparse matrix, independent G2 review, and final acceptance remain open.

## 2026-08-17 Issue #4 Windows ConPTY terminal matrix checkpoint

- `npm run acceptance:windows` passes **17/17** on Windows 11 Pro x64 with `npm run check` at **239/239 and 2 explicit skips**. The new `smoke:tui:terminal:windows` runs the TUI in a real Windows pseudo console (ConPTY via `scripts/pty-host.ps1`, no third-party dependency) and verifies Chinese input, bracketed paste, Ctrl+C, runtime-failure recovery, startup-failure safety, and credential-free evidence.
- `G0-WIN` remains In progress: live DeepSeek/MiniMax Windows journeys, the MiniMax Windows live Gate, the existing-account Credential Manager lifecycle, the Developer-Mode reparse matrix, independent G2 review, and final acceptance remain open.

## 2026-08-17 Issue #4 Windows cross-drive containment checkpoint

- `npm run acceptance:windows` passes **16/16** on Windows 11 Pro x64 with `npm run check` at **239/239 and 2 explicit skips**. The cross-drive containment fix closes the Windows `path.relative` absolute-path loophole in the TUI app-data overlap check, the restricted resource loader, and the Pi session-file check. Directory-link fixtures use junctions on ordinary sessions; file-symlink assertions skip explicitly without Developer Mode and are not treated as Pass.
- `G0-WIN` remains In progress: live DeepSeek/MiniMax Windows journeys, the MiniMax Windows live Gate, the existing-account Credential Manager lifecycle, the Developer-Mode reparse matrix, independent G2 review, and final acceptance remain open.

## 2026-08-17 Issue #4 scope: exact macOS 26.5.2 regression baseline removed

- Per product decision, the exact macOS `26.5.2` compatibility regression baseline is removed from V1 (ADR-0012 supersedes ADR-0009). The MacBook Pro acceptance host runs macOS Tahoe `26.6.1`; `26.5.2` was the pre-upgrade system and is not a V1 target. macOS G2, signing, and final personal acceptance remain open; the `26.5.2` baseline is no longer a gate.
- The `--baseline` runner mode and the `npm run acceptance:macos:baseline` script are removed. Earlier entries that record a blocked `26.5.2` preflight or list exact `26.5.2` regression as a remaining gate are historical evidence and are superseded by this decision.

## 2026-08-17 Issue #4 `b0a5e30` macOS containment revalidation

- Code checkpoint `b0a5e302c1e40b3ef9c60a8747e0491cc6109204` is pushed and matches `origin/codex/candy-v1-foundation`. The change is limited to the macOS Sandbox Runner smoke fixture: it now supplies the real Candy-approved Git common directory instead of omitting the required production approval input.
- `npm run smoke:sandbox:macos` passes workspace guards, native workspace/symlink/symlink-swap containment, default network denial, explicit one-command network capability, cancellation, ordinary and detached descendant cleanup, and parent-exit cleanup. `npm run check` passes **241/241**; current macOS acceptance passes **14/14** at source revision `b0a5e30` with `realPty=true`.
- This is current macOS implementation evidence, not independent G2 approval. The current production gate remains fail-closed until macOS G2; the four medium standard-scan findings, exact `26.5.2`, signing, and final V1 acceptance remain open. Windows is deferred for this work packet and no Windows claim is made. `.omo/` remains user-owned and untracked.

## 2026-08-17 Issue #4 `50074c2` workspace write ordering checkpoint

- Code checkpoint `50074c2ee25ccd3d161d5096a8b6c3fce06cd6f9` is pushed and matches `origin/codex/candy-v1-foundation`. `candy_write` validates the opened regular-file handle and workspace binding before truncating through the handle; the normal write contract remains intact.
- Focused Pi Adapter workspace/security regressions pass **48/48**, full `npm run check` passes **241/241**, and current macOS acceptance passes **14/14** at source revision `50074c2` on macOS `26.6.1` arm64 with a passing real-PTY matrix.
- The current scan still has four medium findings. This checkpoint lowers one write-side effect window but does not clear intermediate directory, Git path-check/use, Pi SessionManager, Trusted Shell descendant, Windows 11, exact `26.5.2`, independent G2, signing, or final V1 gates. `.omo/` remains user-owned, untracked, and preserved.

## 2026-08-17 Issue #4 `88b60be` non-Git snapshot binding checkpoint

- Code checkpoint `88b60be367d69b1c01e7ef26c9b18a9f8e146151` is pushed and matches `origin/codex/candy-v1-foundation`. Non-Git snapshot files are opened with a no-follow final-path handle; pre/post identity checks must match the opened handle, and metadata is taken from that handle. Mismatches fail closed.
- Full `npm run check` passes **241/241** and current macOS acceptance passes **14/14** at source revision `88b60be` on macOS `26.6.1` arm64 with a passing real-PTY terminal matrix.
- The current scan reports four open medium findings. It closes only the low file-metadata race category; it does not establish descriptor-relative/reparse-safe directory operations, clear the worktree/session/Trusted Shell residuals, or provide Windows 11, exact `26.5.2`, independent G2, signing, or final V1 evidence. `.omo/` remains user-owned, untracked, and preserved.

## 2026-08-17 Issue #4 platform preflight audit

- Current HEAD `b66a725` ran `npm run acceptance:macos:baseline` with Node `22.23.2`/npm `10.9.8`; the command built successfully and then recorded **0/0 with 1 blocked preflight** because the host is `26.6.1` arm64, not exact `26.5.2`. The generated report is source-bound to `b66a725` and is not baseline acceptance evidence.
- Current HEAD also ran `npm run acceptance:windows`; the build succeeded, then the acceptance script rejected the non-Windows host before running Windows steps. No Windows acceptance result is claimed. A Windows 11 x64 host remains required.
- The platform blockers are environmental gates, not reasons to weaken the TUI or substitute cross-host tests. They remain open together with the four current medium security findings, platform G2, signing, and final V1 acceptance.

## 2026-08-17 Issue #4 `2c4215b` Apply/worktree checkpoint

- Code checkpoint `2c4215bb4ba8be85dd8860c4f68550df4b2a11e0` is pushed to and matches `origin/codex/candy-v1-foundation`. Full `npm run check` passes **241/241**; current macOS acceptance passes **14/14** at source revision `2c4215b` on macOS `26.6.1` arm64 with a passing real-PTY terminal matrix.
- The new root binding closes common root replacement windows around Git and Apply commands but does not establish atomic descriptor-relative or Windows reparse-safe execution. The current scan keeps five source-backed residual findings open. Windows 11, exact macOS `26.5.2`, independent G2, signing, final V1 acceptance, and `.omo/` preservation boundaries remain open gates.

## 2026-08-17 Issue #4 `6f63c3e` workspace binding checkpoint

- Code checkpoint `6f63c3ee51aad91d00dd2002d13084deff573c11` is pushed to and matches `origin/codex/candy-v1-foundation` (remote SHA verified). Workspace file operations now validate the opened file against the bound root and canonical path; non-Git traversal rechecks directory identity after enumeration; a selected-root symlink regression covers the new root binding.
- Full `npm run check` passes **239/239**, and current macOS acceptance passes **14/14** at source revision `6f63c3ee51aad91d00dd2002d13084deff573c11` on macOS `26.6.1` arm64. This reduces common final-file/root replacement routes but does not clear descriptor-relative/reparse-safe races in directory creation, Apply/worktree, session-manager, or file-level snapshot operations.
- Current scan `631e277f-7272-4d06-9d00-70f486f0a0ab` reports **5 open findings (4 medium, 1 low)** and is explicitly partial. Windows 11, exact macOS `26.5.2`, independent G2, signing, final V1 acceptance, and `.omo/` preservation boundaries remain as recorded gates.

## 2026-08-17 Issue #4 current-HEAD scan `2c682ace`

- The scan is bound to current docs HEAD `09dc079` and reports **5 open findings: 4 medium, 1 low**. The parent fallback was used because all six subagent slots were occupied; coverage is partial and `.omo/**` was explicitly excluded and preserved.
- Open security blockers are Apply/worktree races, workspace-operation races, residual session-root replacement races, non-Git traversal races, and nested-interpreter Trusted Shell publication policy. The scan report is not a clearance.
- Windows 11, exact macOS `26.5.2`, independent G2, signing, and final V1 acceptance remain open.

## 2026-08-17 Issue #4 `e6170b6` Pi session-root checkpoint

- Code checkpoint `e6170b6782908aa29b8a43337b3e6cffa67d1f38` is pushed and matches `origin/codex/candy-v1-foundation`. Session root/task directories reject symlinks, and reload/recovery/selected existing sessions validate regular files and use no-follow handles; the new regression covers a symlinked task directory in both the store and Pi engine paths.
- Focused Pi adapter tests pass **47/47**, full `npm run check` passes **238/238**, and post-push macOS acceptance passes **14/14** at source revision `e6170b6782908aa29b8a43337b3e6cffa67d1f38`.
- This is narrow symlink-route hardening, not proof of full descriptor-relative or OS-level replacement-race safety. Remaining blockers include workspace/apply/worktree and residual session/non-Git races, nested-interpreter Trusted Shell publication policy, Windows 11, exact macOS `26.5.2`, independent G2, signed release, and final V1 acceptance. `.omo/` remains user-owned, untracked, and preserved.

## 2026-08-17 Issue #4 `1bcdd9f` non-Git snapshot checkpoint

- Code checkpoint `1bcdd9f2fd51bd97d45b9f9279ad869e472c5f2f` is pushed and matches `origin/codex/candy-v1-foundation`. Non-Git snapshots lstat the root and children, reject symlinks and non-regular entries, and do not recurse through symlinked directories; the new regression confirms outside-root symlink content is not captured.
- Focused runtime tests pass **31/31**, full `npm run check` passes **237/237**, and post-push macOS acceptance passes **14/14** at source revision `1bcdd9f2fd51bd97d45b9f9279ad869e472c5f2f`.
- This is a narrow symlink-follow hardening checkpoint, not proof of full descriptor-relative or OS-level replacement-race safety. Remaining blockers include workspace/apply/worktree/session races, residual non-Git race analysis, nested-interpreter Trusted Shell publication policy, Windows 11, exact macOS `26.5.2`, independent G2, signed release, and final V1 acceptance. `.omo/` remains user-owned, untracked, and preserved.

## 2026-08-17 Issue #4 `7489139` attachment-source checkpoint

- `7489139e07dfcea241fa421144541df6e2c06c39` is pushed and matches `origin/codex/candy-v1-foundation`. The TUI no longer reopens the attachment source by path after inspection; it validates and reads one opened handle with a bounded size and a platform-aware no-follow final flag.
- Focused TUI tests pass **39/39**, full `npm run check` passes **236/236**, and post-push macOS acceptance passes **14/14** with source revision `7489139e07dfcea241fa421144541df6e2c06c39`.
- The pre-checkpoint scan's attachment-source finding is addressed. The remaining six-finding categories are not cleared: workspace containment, Apply/worktree races, session-root access, non-Git snapshot traversal, and nested-interpreter Trusted Shell publication. Windows 11, exact macOS `26.5.2`, independent G2, signed release, and final V1 acceptance remain open. `.omo/` remains user-owned, untracked, and preserved.

## 2026-08-17 Issue #4 `e7ba88b` checkpoint blockers

- Native request materialization is now bounded before spawn: `npm run check` **236/236**, native focused tests **14/14**, and current macOS acceptance **14/14** at `e7ba88b`.
- The older scan snapshot's native request finding is addressed, but the snapshot is not a clearance for current HEAD. Remaining blockers are descriptor-relative/reparse-safe filesystem races, nested-interpreter Trusted Shell publication policy, Windows 11 acceptance, exact macOS `26.5.2`, independent G2 approval, signed release, and final V1 acceptance. `.omo/` remains user-owned, untracked, and preserved.

## 2026-08-17 Issue #4 `23b3f67` checkpoint blockers

- Provider stream cancellation is now verified: `npm run check` **235/235**, native check and Pi cancellation smoke pass, current macOS acceptance is **14/14**, and current-source DeepSeek/MiniMax gates are **7/7** and **8/8**.
- The older scan snapshot's provider-reader finding is addressed, but the snapshot is not a clearance for current HEAD. Remaining blockers are descriptor-relative/reparse-safe filesystem races, nested-interpreter Trusted Shell publication policy, Windows 11 acceptance, exact macOS `26.5.2`, independent G2 approval, signed release, and final V1 acceptance. `.omo/` remains user-owned, untracked, and preserved.

## 2026-08-17 Issue #4 `8f3bf78` checkpoint blockers

- The TUI evidence-sanitization checkpoint is verified: `npm run check` **233/233**, current macOS acceptance **14/14**, DeepSeek **7/7**, and domestic MiniMax **8/8**, all current reports source-bound to `8f3bf78`.
- Open blockers are unchanged in substance: descriptor-relative/reparse-safe filesystem races, nested-interpreter Trusted Shell publication policy, Windows 11 acceptance, exact macOS `26.5.2`, independent G2 approval, signed release, and final V1 acceptance. The `.omo/` directory remains user-owned, untracked, and preserved.

Current policy note: the primary macOS acceptance environment is the current Tahoe `26.x` arm64 host (currently `26.6.1`). Exact `26.5.2` is a separate compatibility regression baseline. Historical `26.5.2` rows below remain evidence records; use `npm run acceptance:macos` for current-host validation and `npm run acceptance:macos:baseline` for the exact baseline.

Post-`961537a` current-host revalidation: `npm run acceptance:macos` passes **14/14** at source revision `961537af4b90350c95910342c41c7f947830a9e3`, with deterministic `npm run check` at **201/201**. The earlier 199/199 figure in the checkpoint note below is historical evidence.

Post-`a28606c` current-host revalidation: `npm run acceptance:macos` passes **14/14** with deterministic `npm run check` at **203/203** on macOS `26.6.1` arm64. The retry/compaction and pre-cancel lifecycle evidence is current-host deterministic evidence only.

Post-`236b2f2` current-host revalidation: `npm run acceptance:macos` passes **14/14** with deterministic `npm run check` at **204/204**. Resource diagnostics remain deterministic TUI evidence; Windows and exact-baseline gates remain external.

Post-compaction-cancellation evidence: `npm run check` passes **205/205**; the TUI cancellation regression covers a turn paused after compaction starts.

Post-production-Pi-compaction evidence: `npm run check` passes **207/207**; production Pi fixtures cover overflow recovery and cancellation during an in-flight compaction request.

Post-live-provider-revalidation evidence: source revision `7f2d967` passes the Candy-owned DeepSeek Gate **7/7** and domestic MiniMax Gate **8/8**; sanitized reports are bound to this revision.

Post-native-containment-revalidation evidence: current source revision `38775e2` passes the macOS strict Sandbox Runner matrix for workspace/symlink containment, Git metadata/ref/reflog write denial, default network denial, descendant cancellation, and parent-exit cleanup. This remains implementation evidence and is not an independent G2 approval.

Post-clean-install evidence: pinned `npm ci --ignore-scripts` completed with an unchanged lockfile, 0 vulnerabilities, successful toolchain assertion, and successful build.

Current Issue #4 checkpoint note: the active V1 release line is TUI-only on macOS and Windows 11. Checkpoint `bd8428b` is the current published HEAD. Current macOS acceptance passes 14/14 with deterministic check 229/229; DeepSeek passes 7/7 and domestic MiniMax passes 8/8. The sealed scan reports eight findings for the prior `1783e64` snapshot, including descriptor-relative TOCTOU, nested-interpreter publication indirection, and session/attachment races; it is not evidence that `bd8428b` is clean. Windows 11 execution remains pending a Windows 11 host. The exact `26.5.2` runner correctly stops at preflight on this `26.6.1` host; macOS evidence is not used as Windows evidence. Desktop, Browser Workspace, and dependent workflows are V2. Trusted Shell remains subject to each platform's independent native security gate.

## 2026-08-17 Issue #4 `c6eb334` checkpoint blockers

- Code checkpoint `c6eb334d6578d5db5d76a672339a05d12b3b3cf5` adds exclusive/no-follow attachment metadata creation, regular-file validation on metadata reads, duplicate-put compatibility, and a pre-existing metadata-symlink regression. Current macOS `26.6.1` arm64 acceptance passes **14/14** with embedded `npm run check` **232/232**; current-source DeepSeek passes **7/7** and domestic MiniMax passes **8/8**.
- The current reports are source-bound to `c6eb334`. The attachment metadata symlink finding from scan `76445169-b4e0-4e89-9f30-a22cf156b5d9` is addressed; descriptor-relative/reparse-safe filesystem races, nested-interpreter publication indirection, Windows 11, exact macOS `26.5.2`, independent G2, and final V1 acceptance remain open.

## 2026-08-17 Issue #4 Trusted Shell gate correction

- Checkpoint `5f3b727c4e1b576321c5dcf217cd1784019637f5` removes the macOS Darwin arm64 host/architecture shortcut from the production Trusted Shell gate. The normal TUI composition root and the shared platform capability now remain fail-closed until independent G2 approval; targeted regressions and `npm run check` **231/231** pass.
- This closes the source-level premature-enable defect. It does not close the independent G2 decision, nested-interpreter publication policy, descriptor-relative/reparse-safe filesystem races, Windows 11 acceptance, or exact macOS `26.5.2` evidence.

- Fresh whole-repository scan `76445169-b4e0-4e89-9f30-a22cf156b5d9` is complete against `2911fcd`; its 9 findings remain open and the report is not treated as a clearance for the later `5f3b727` source-gate correction.
- Native descriptor-relative/no-reparse remediation is still required for workspace, attachment, session, non-Git snapshot, Apply, and Worktree TOCTOU paths. The current TypeScript checks reduce ordinary path escapes but do not prove OS-level race safety.
- macOS Trusted Shell nested-interpreter publication policy remains unresolved. Windows Trusted Shell remains fail-closed until its native gate is independently accepted.
- Windows 11 TUI acceptance, exact macOS `26.5.2` regression, signed release, independent G2 approval, and final V1 acceptance remain unavailable or open.

## 2026-08-17 Issue #4 current checkpoint

- `7aa382c2330e5c62acd51cfa97c176c74d81938f` is the published canonical-branch HEAD. Current macOS acceptance passes **14/14**, `npm run check` passes **220/220**, DeepSeek passes **7/7**, and domestic MiniMax passes **7/8** because LIVE-MM-03 did not satisfy the thinking/tool-delta assertion.
- Remaining blockers include five findings from sealed scan `e7f04f06-b75a-468a-9a74-5a027404708a`: pathname TOCTOU containment, nested-interpreter publication bypass, post-materialization JSONL limits, stale app-server owner recovery, and attachment/non-Git snapshot aggregate bounds. Windows 11 execution, exact macOS `26.5.2`, signed release, and independent Trusted Shell/G2 approval also remain open.

## 2026-08-17 Issue #4 Pi-backed TUI journey checkpoint

- Checkpoint `456bab2` adds `smoke:tui:pi`, which drives the production `PiAgentEngine` through the Candy TUI with deterministic mocked DeepSeek SSE. The smoke proves the approved DeepSeek URL, visible TUI completion, Candy-owned task/transcript/session persistence, and absence of the fixture credential from session data without reading any real provider credential.
- Current macOS Tahoe `26.6.1` arm64 acceptance passes **10/10** and `npm run check` passes **197/197**; native, credential presence-only, responsiveness, TUI journey, and real PTY terminal gates pass. This is current-host implementation evidence, not Windows, exact `26.5.2`, G2, signed-release, or final V1 evidence.
- Windows 11 x64 execution, exact `26.5.2` regression, independent platform Trusted Shell G2, live provider cancellation, signed release, and final V1 acceptance remain open.

## 2026-08-17 Issue #4 Pi-backed tool-loop checkpoint

- Checkpoint `737d7d7` adds `smoke:tui:pi:tool`, driving the production `PiAgentEngine` through the Candy TUI with deterministic mocked DeepSeek SSE. The smoke proves a bounded `candy_write` call, the follow-up provider turn, the approved DeepSeek URL, visible tool output, Candy-owned task/transcript/session persistence, and absence of the fixture credential from session data.
- Current macOS Tahoe `26.6.1` arm64 acceptance passes **11/11** and `npm run check` passes **197/197**; native, credential presence-only, responsiveness, Pi text/tool journeys, TUI journey, and real PTY terminal gates pass. This is current-host implementation evidence, not Windows, exact `26.5.2`, G2, signed-release, or final V1 evidence.
- Windows 11 x64 execution, exact `26.5.2` regression, independent platform Trusted Shell G2, live provider cancellation, signed release, and final V1 acceptance remain open.

## 2026-08-17 Issue #4 credential revocation checkpoint

- Checkpoint `34ae949` adds `smoke:tui:credential-revocation`, using an in-memory Candy credential store, the production `PiAgentEngine`, the real TUI control loop, and deterministic mocked DeepSeek SSE. The smoke does not mutate the user's Keychain: after the initial completed provider turn, TUI deletion makes the next provider operation return `needs_credentials` and no second provider request is observed.
- Previous transcript history remains intact and the Candy-owned session remains credential-free. Current macOS Tahoe `26.6.1` arm64 acceptance passes **12/12** and `npm run check` passes **197/197**.
- This closes only the current-host TUI revocation evidence. Windows 11 x64, exact macOS `26.5.2`, platform Trusted Shell G2, live provider cancellation, signed release, and final V1 acceptance remain open.

## 2026-08-17 Issue #4 Pi coding review/restart checkpoint

- Checkpoint `a36aac4` adds bounded, sanitized workspace review metadata to Candy-owned SQLite and restores it across TUI restart. A new continuation clears stale review state; explicit Apply remains the only handoff path.
- `smoke:tui:pi:coding` drives the production `PiAgentEngine` through `candy_write`, review commands, restart, transcript inspection, and Apply. It proves two approved DeepSeek requests, persisted task/tool evidence, workspace mutation, unchanged Git HEAD/index, and a credential-free session.
- Current macOS Tahoe `26.6.1` arm64 acceptance passes **13/13** and `npm run check` passes **199/199**. Windows 11, exact macOS `26.5.2`, platform Trusted Shell G2, live provider cancellation, signed release, and final V1 acceptance remain open.

## 2026-08-17 Issue #4 Pi provider cancellation checkpoint

- Checkpoint `54b54c1` adds `smoke:tui:pi:cancellation`, which uses the production `PiAgentEngine`, real TUI cancellation, and a deterministic DeepSeek SSE stream. It sends partial output, issues `:cancel`, observes provider abort, and verifies the task is cancelled without false completion.
- The smoke preserves partial assistant transcript evidence, limits the run to one approved domestic DeepSeek request, and scans the Candy-owned session for credentials. Current macOS Tahoe `26.6.1` arm64 acceptance passes **14/14** with Node `22.23.2`/npm `10.9.8` and `npm run check` at **199/199**.
- This closes only the current-host TUI cancellation evidence. Windows 11, exact macOS `26.5.2`, platform Trusted Shell G2, live-provider acceptance, signed release, and final V1 acceptance remain open.

## 2026-08-17 Issue #4 Candy prompt invocation checkpoint

- Checkpoint `961537a` adds `:prompts` and `:prompt <name> [args]` to the Interactive TUI. It reads only Candy-owned app-data `prompts/*.md` through the restricted loader, supports quoted arguments and `$1..$99`/`$ARGUMENTS`/`$@` expansion, and rejects malformed, oversized, control-character, empty, unknown, or credential-bearing invocations.
- `npm run check` passes **201/201** on Node `22.23.2`/npm `10.9.8`; the new regression covers listing, quoted expansion, secret redaction, unknown-template rejection, and the argument bound.
- This closes the deterministic implementation gap for Issue #4 user story #27 only. It does not close Windows 11, exact macOS `26.5.2`, live-provider revalidation on this revision, G2, signing, or final V1 acceptance.

## 2026-08-17 Issue #4 lifecycle projection checkpoint

- Checkpoint `a28606c` closes the TUI observability gap for successful provider retries: retry start, retry success/failure, compaction start/completion, `turn settled`, and final completion are now visibly ordered.
- The Pi Adapter rejects a pre-cancelled turn before acquiring a credential lease or issuing a provider request. Deterministic TUI/adapter evidence is **203/203** on Node `22.23.2`/npm `10.9.8`; current macOS acceptance is **14/14**.
- This is implementation evidence only. Windows 11, exact macOS `26.5.2`, live-provider revalidation on `a28606c`, G2, signing, and final V1 acceptance remain open.

## 2026-08-17 Issue #4 resource diagnostics checkpoint

- `236b2f2` adds TUI `:resources` diagnostics for malformed Candy skills and conflicting prompt names. The command exposes bounded type/message/path metadata only and never displays resource content.
- `npm run check` passes **204/204** and current macOS acceptance passes **14/14**. This is deterministic current-host evidence, not Windows or exact-baseline evidence.
- Windows 11, exact macOS `26.5.2`, live-provider revalidation on `236b2f2`, G2, signing, and final V1 acceptance remain open.

## 2026-08-17 Issue #4 compaction cancellation evidence checkpoint

- The TUI regression holds a turn after compaction starts, cancels through `:cancel`, and confirms the final task state is `cancelled` without a settled or completed projection.
- This is deterministic TUI evidence only; production Pi overflow/compaction cancellation, Windows 11, exact macOS `26.5.2`, native Trusted Shell G2, signing, and final V1 acceptance remain open.

## 2026-08-17 Issue #4 production Pi compaction checkpoint

- Production `PiAgentEngine` fixtures now cover context overflow, compaction summary completion, continuation, and cancellation while the compaction provider request is unsettled. The cancellation path rejects as cancelled and emits no false completion.
- `npm run check` passes **207/207** on the pinned Node `22.23.2`/npm `10.9.8` toolchain. Remaining blockers are Windows 11, exact macOS `26.5.2`, native Trusted Shell G2, live-provider revalidation on this revision, signing, and final V1 acceptance.

## 2026-08-17 Issue #4 live provider revalidation checkpoint (source `7f2d967`)

- The Candy-owned DeepSeek live Gate passes **7/7** against `https://api.deepseek.com`; the domestic MiniMax live Gate passes **8/8** against `https://api.minimaxi.com`. Both reports cover cancellation, controlled error contracts, secret-free session scanning, and secret-lease release; MiniMax also covers the image and thinking/tool paths.
- Reports are sanitized and source-bound to `7f2d967`. This closes current-host provider revalidation only; Windows 11, exact macOS `26.5.2`, native Trusted Shell G2, signing, and final V1 acceptance remain open.

## 2026-08-17 Issue #4 historical live provider checkpoint (source `b23383a`)

- Source revision `b23383a` passes the Candy-owned DeepSeek live gate **7/7** against `https://api.deepseek.com`, covering streaming, tool/replay, cancellation, controlled error contracts, secret-free session scanning, and secret-lease release.
- The same revision passes the domestic MiniMax live gate **8/8** against `https://api.minimaxi.com`, covering text, image, thinking/tool replay, cancellation, controlled error contracts, `LIVE-MM-05` product policy, secret-free session scanning, and secret-lease release.
- The sanitized reports are local under `out/acceptance/live/` and contain no credential value, fingerprint, header, prompt, or raw provider payload. This clears the current-host provider-path evidence only; Windows 11, exact macOS `26.5.2`, platform Trusted Shell G2, signing, and final V1 acceptance remain open.

## 2026-08-17 Issue #4 current macOS native containment revalidation checkpoint (source `38775e2`)

- The strict Sandbox Runner matrix passes workspace/symlink containment, Git metadata/ref/reflog write denial, default network denial with explicit capability separation, ordinary and detached descendant cancellation, and parent-exit cleanup.
- This is current-host native implementation evidence only. The independent G2 security decision, Windows 11 native containment, exact macOS `26.5.2`, signing, and final V1 acceptance remain open.

## 2026-08-17 Issue #4 clean-install checkpoint (source `fd070e1`)

- `npm ci --ignore-scripts` passed on Node `22.23.2`/npm `10.9.8`, with no `package-lock.json` change and 0 vulnerabilities; toolchain assertion and build passed afterward.
- This is current-host ACC-TUI-01 evidence only. Windows 11, exact macOS `26.5.2`, G2, signing, and final V1 acceptance remain open.

| ID                | Owner                                    | Status      | Blocks                                                                                        | Validation procedure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0-LIVE-DS        | Product owner + implementation agent     | Pass        | No remaining DeepSeek provider-matrix block; broader ACC/release evidence remains separate    | Windows 11 Gate passed 7/7 on 2026-08-10, and the macOS Gate passed 7/7 on 2026-08-12 at source revision `7242b74` and again 7/7 on 2026-08-13 at source revision `e3449a5`: `LIVE-DS-01..04`, cancellation, controlled 401/429/timeout, secret-free session scan, and secret-lease release. The host-specific reports remain separate; this is not final V1 or release acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| G0-LIVE-MM        | Product owner + implementation agent     | Pass        | No remaining MiniMax provider-matrix block; broader ACC-04/release evidence remains separate  | macOS `26.5.2` arm64: the Candy-owned `minimax-cn` Keychain credential was provisioned on 2026-08-13 and the live gate at source revision `44be499` passes LIVE-MM-01 text, LIVE-MM-02 image understanding, LIVE-MM-03 thinking/tool replay, LIVE-MM-04 cancellation plus controlled 401/429/timeout error contracts, and the secret-free-session/secret-lease-release checks. LIVE-MM-05 is a default-Pass product-policy row; no separate provider-console plan, quota, balance, or usage-deduction confirmation is required. Host-specific reports remain separate; this is not final V1, ACC-04, or release acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| G0-MAC            | Product owner                            | In progress | Complete macOS acceptance                                                                     | The local macOS `26.5.2` arm64 strict-containment checkpoint passes `acceptance:macos` 20/20 with `check` at 109/109 tests. The ten-run report records TUI/Desktop cold p95 `562/2042 ms`, Runtime projection `1 ms`, validator parent-and-descendant termination `13 ms`, explicit Take Control rejection `2 ms`, and concurrent renderer frame-gap `19 ms`; all ten three-task runs passed. The run includes strict native containment, packaged recovery, sequential handoff, long-running approval/steering, credential-isolation, coding-journey/reopened-transcript, and Browser fixtures under temporary Candy-owned app-data roots. This closes the deterministic repair checkpoint, not complete acceptance: user cancellation to a real Provider stream-stop request, full UI/recovery ACC-12 evidence, physical input-origin, Windows parity, signing, independent native-security review, and live-provider evidence remain Blocked.                                                                                                                                                                                                                                                                                                                                                                 |
| G0-WIN            | Product owner + implementation agent     | In progress | Windows and cross-platform V1 release claims                                                  | The Windows 11 Pro x64 TUI deterministic runner passes 17/17 at the current HEAD, including the cross-drive containment fix (deterministic check 239/239 with 2 explicit Developer-Mode skips), TUI launcher/credential/revocation, Pi text/tool/coding/cancellation journeys, TUI task, Windows TUI journey, real ConPTY terminal matrix, Credential Manager lifecycle, native fail-closed gate, and responsiveness. The earlier 22/22 run at `b7cab12` additionally passed user-cancelled long-running validator cleanup, queued/active process-restart recovery, attachment restart recovery, non-owner read-only fencing, bounded three-slot concurrency, unsigned packaged Desktop JSONL smoke, packaged recovery/handoff/long-running/credential-isolation/coding-journey smoke, and extended packaged Browser action/adversarial fixtures. The ten-run ACC-12 deterministic subset passes cold start, Runtime-to-UI projection, cancellation to process-tree termination, Browser Take Control, and three-task renderer frame gap with zero event loss; continue the dedicated checklist for signed installation, complete Browser physical-input/coverage, complete G2, real-Provider cancellation, remaining ACC metrics, and external provider/signing gates.                                                                                                                                        |
| G1-PERSISTENCE    | Implementation agent                     | In progress | Final persistence acceptance                                                                  | Local Node 22 import, two-connection fencing, WAL/restart recovery, schema migration, task-run metadata, deterministic app-server command loop, and unsigned packaged Windows app-server JSONL smoke pass; run signed/package topology and macOS tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| G2-SANDBOX        | Implementation agent + security reviewer | In progress | Shell-enabled Auto and Shell Auto Debug                                                       | ADR-0010 permits the macOS TUI Trusted Shell Auto Personal Preview after explicit user selection, Auto profile, and Git Task Worktree creation. The source path now uses default-off native network capability, one-command macOS outbound elevation, bounded/redacted output, credential rejection, cancellation, and resumable denial. The macOS `26.5.2` arm64 strict-containment checkpoint passes supported-validator, outside read/write, symlink read/write, symlink-swap, loopback-network, and detached-descendant checks. This is not G2 completion: independent security review, real PTY/provider journey, signed packaging, Windows parity, and final cross-platform evidence remain open; release Shell Auto and Shell Auto Debug stay gated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| G3-BROWSER        | Implementation agent                     | In progress | Browser Workspace and automatic takeover claim                                                | Packaged Windows and macOS loopback fixtures prove explicit site allow, observation, structured click/type/confirmed-submit, stale/user-owner rejection, screenshot attachment ids, URL/action/selector target rejection, disallowed redirect/popup/permission/download default-deny, and the explicit Take Control fallback. The macOS `b516739` regression was reproduced and fixed: the fixture now passes temporary `HOME`/`TMPDIR` plus an explicit Candy-owned `CANDY_APP_DATA_ROOT`, while the marker scan still covers stdout/stderr, app-server JSONL, and Candy `sessions`, `state`, `attachments`, `worktrees`, and `downloads`; only `browser-profile` and Electron `Partitions` are excluded for expected local Browser Profile persistence. The fixed smoke passes with inert prompt-injection text, a same-revision renderer navigation race with one accepted revision-fenced request, and a conflicting action invalidated by Take Control. This deterministic no-provider isolation evidence is not complete `ACC-09`: it does not prove live Provider propagation, complete session/protocol acceptance, broader hostile-page coverage, or physical input-origin detection. Reliable input-origin evidence remains open; use explicit Take Control because automatic takeover is not claimed. |
| SIGNING           | Product owner                            | Blocked     | Signed/notarized release evidence                                                             | The Windows release pipeline is scripted and verified, but no approved code-signing identity is present on this host: the user store contains only two unrelated self-signed certificates without the Code Signing EKU, and no PFX, signing env var, or Azure Trusted Signing configuration was found. Provide the approved Windows/Apple identities only through approved platform tooling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| G2-PRIVILEGE      | Product owner + implementation agent     | Blocked     | OS-level no-network / workspace containment implementation and verification                   | The Windows host session runs at Medium integrity without `SeCreateAppContainerPrivilege`; `New-AppContainerProfile` fails and WFP filters require elevation, so AppContainer/WFP-based OS-level no-network and arbitrary-command workspace containment cannot be implemented or verified in this session. The independent security review is also an external input.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| G0-DS-ADAPTER     | Implementation agent                     | Pass        | No remaining live Flash/Pro adapter-matrix block; broader ACC-03/04 evidence remains separate | The Windows Pi-backed Gate passed 7/7 on 2026-08-10 and the macOS Pi-backed Gate passed 7/7 on 2026-08-12 and again on 2026-08-13 at source revision `e3449a5`. The macOS run used only Candy's `candy-v1/deepseek` Keychain path and `https://api.deepseek.com`; no unattended run may inspect or import another tool's credentials.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| G0-MAC-RUNTIME    | Product owner                            | In progress | Runtime cross-platform claim                                                                  | macOS `26.5.2` arm64 Runtime/session-remap, source app-server owner recovery, packaged Node/app-server recovery, and packaged sequential pause/resume handoff pass deterministically, including stale-revision fencing and validator-descendant cleanup; complete the cross-platform TUI/Desktop ownership, UI restart/session, and full recovery matrix before clearing this blocker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| G1-ELECTRON       | Implementation agent                     | In progress | Packaged Desktop acceptance                                                                   | macOS `26.5.2` arm64 local packaged Electron 43.2.0 + Node 22.23.2 child, JSONL round-trip, ad-hoc signature, quit cleanup, embedded packaged Node/app-server recovery, packaged sequential handoff with revision/owner fencing and descendant cleanup, packaged long-running approval/steering, packaged credential-isolation, packaged coding journey/reopened transcript, and loopback Browser fixture pass; Windows x64 unsigned Electron 43.2.0 + Node 22.23.2 + native runner package and JSONL smoke pass. Verify Apple/Windows signed installation, full UI recovery, Browser input-origin, and signing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| G1-KEYRING        | Product owner + implementation agent     | In progress | ACC-02 OS credential acceptance                                                               | Candy-owned service/account mapping, Windows Credential Manager synthetic lifecycle, the bundled packaged Node/keyring lifecycle (`absent -> present -> present -> absent`), and the packaged Windows Desktop credential-isolation smoke (renderer write/presence/delete only; complete value never observable) pass. The macOS packaged renderer isolation smoke now uses only an in-memory synthetic store and does not touch Keychain; mutate the existing DeepSeek account only under a controlled user-authorized window and verify the signed Desktop path without exposing complete credentials.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| G2-NATIVE         | Security reviewer + implementation agent | In progress | Shell-enabled Auto and shell-based Auto Debug                                                 | Windows 11 native smoke proves Job Object process ownership, complete descendant cancellation on runner close, protocol network rejection, workspace escape rejection, junction reparse rejection, missing-executable rejection, bounded oversized child output, and pre-resume canonical launch-path revalidation; OS-level no-network containment and post-resume reparse/race protection remain open. macOS now has source-backed strict Seatbelt evidence plus an explicit outbound-capability smoke; default-off network behavior, workspace containment, and descendant cancellation pass. Packaging and the independent security review remain open, so macOS Personal Preview implementation is available but release Shell Auto/Auto Debug are not accepted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| G4-WORKTREE       | Implementation agent                     | In progress | Reviewed Apply Changes acceptance                                                             | Desktop Apply runs through a real Task Worktree handoff with persisted association, explicit discard, and patch-truncation/manifest-change guards; macOS `/var` to `/private/var` canonical association, cross-host Windows path-seam fixtures, dirty target, changed base, conflict, untracked collision, real Windows Git worktree/Apply/restart fixtures, and junction escape rejection pass. Broader platform matrices, Windows reparse-point evidence, and security review remain under G0-WIN/G2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| G5-PERSISTED-AUTO | Implementation agent                     | In progress | Long-running product acceptance                                                               | Auto tasks now alternate bounded normal turns and the same validator, persist run progress/stop reasons, expose Desktop progress, mark restart uncertainty as `crash_interrupted`, and pass Windows/macOS packaged approval/steering and validator evidence; complete user steering/approval integration, final evidence summary, native shell validator, and packaged/platform evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 2026-08-14 Issue #3 macOS Personal Preview security decision

- The final standard security scan at source revision `9c5afadb74895de9c688445b4889773de873d34a` reviewed the Issue #3 boundary across the 168-file repository snapshot and reported **0 reportable findings**. The macOS arm64 TUI composition root is therefore enabled for the bounded Personal Preview path.
- Current-host evidence is macOS Tahoe `26.6.1` arm64 only: acceptance `21/21`, full check `178/178`, Rust `7/7`, DeepSeek live gate `7/7`, three real Provider/Pi journeys, dogfood `3/3` with zero safety failures, and real PTY matrix pass. The evidence is not a Windows, exact `26.5.2`, signed-release, Desktop Shell, or final V1 claim.
- `G2-NATIVE` remains in progress for the broader product boundary: Windows and Desktop Trusted Shell remain disabled, Shell-based Auto Debug remains disabled, and exact-version/release/product gates remain separate.

## 2026-08-14 Trusted Shell Auto evidence update

- The prior `G2-SANDBOX` / `G2-NATIVE` rows remain open because the independent G2 security decision has not yet been accepted. The evidence boundary is narrower than those rows' historical wording: evidence-producing revision `fb400aa` on macOS Tahoe `26.6.1` arm64 now has three clean real-PTY + real DeepSeek Flash journeys, and a separate three-category dogfood run at 3/3 with zero safety failures.
- The three journeys prove offline `candy_bash`, one approved bounded `candy_bash_network` command, validator and reviewed Apply, task-owned cancellation, restart recovery, unchanged Git HEAD/index, and sanitized credential-free evidence. The dogfood run separately proves repository understanding, small repair, and failing-test diagnosis in a Candy Task Worktree.
- The current native matrix also rejects Git ref and reflog writes, while the real terminal matrix covers Chinese input, bracketed paste, resize, startup/runtime failure recovery, and Ctrl+C; its scan includes the complete temporary Worktree/app-data/PTY fixture. The TUI deterministic suite covers approval settlement on exit, stale approval rejection after restart, and dead-owner recovery without replay. These additions strengthen implementation evidence only and do not constitute independent G2 approval.
- The current macOS native matrix also kills the delayed descendant when its Candy Native Runner parent is forcibly terminated; this is process-lifecycle evidence, not independent G2 approval and not Windows evidence.
- On evidence-producing revision `fb400aac4e6570e567e95daeb36ce1ff72cf7ec0`, the real-PTY matrix and three real-provider Trusted Shell attempts pass on macOS `26.6.1` arm64; the separate dogfood categories pass `3/3` with zero safety failures. These current-host results still do not prove Windows, exact `26.5.2`, signed packaging, independent G2, or final V1 acceptance.
- The PTY evidence sends verified Chinese UTF-8 and bracketed-paste bytes; an OS-level Chinese IME composition path remains unverified and is not claimed as passed.
- Follow-up revision `fd7f658` also passes the current-host deterministic/package acceptance runner `21/21`; the `/tmp` to `/private/tmp` metadata-only alias fix remains macOS containment evidence, not an independent G2 decision or Windows evidence.
- This does not prove Windows, exact macOS `26.5.2`, signed packaging, or final V1 acceptance. The normal TUI composition root remains default-off; only the explicit acceptance composition root enables the capability while G2 is pending.

## 2026-08-14 Trusted Shell credential-redaction follow-up

- Current published revision `aea91a6d3fcd9a0eb09ea2dac2460808747dd1b7` fixes the prior selected-provider-only shell redaction gap by carrying all active Candy provider secrets through the Trusted Shell turn and deduplicating them at the Pi adapter boundary. The focused TUI regression and the current security diff scan report no remaining finding for this path.
- Current macOS `26.6.1` arm64 evidence on this revision is `npm run check` **172/172**, acceptance **21/21**, three real provider/Pi Trusted Shell attempts passed, dogfood **3/3** with zero safety failures, and the real PTY matrix passed with credential-free evidence. This strengthens implementation evidence only; it does not close `G2-SANDBOX` or `G2-NATIVE`.
- The normal TUI composition root remains default-off. Independent macOS G2 review, exact `26.5.2`, Windows parity, signed packaging, and final V1 acceptance remain open; no release Shell Auto or Shell Auto Debug claim is made.

## 2026-08-14 Independent security review result

- The standard repository security scan completed with **5 open findings (3 high, 2 medium)**. It is partial for whole-repository coverage, but the reported Trusted Shell and credential-boundary findings are sufficient to keep `G2-SANDBOX` and `G2-NATIVE` open.
- High findings: macOS normal-completion process-tree cleanup does not cover detached descendants; Pi public file reads can place active provider credentials into session content; and Trusted Shell does not enforce the no-commit/no-push boundary before approval/spawn.
- Medium findings: approval responses are not fenced to the current task owner, and Desktop attachment ingestion does not centrally screen active-provider credentials before persistence/submission.
- Current-host reproduction: an intentionally detached child remained able to write inside the Task Worktree 1.6 seconds after the Trusted Shell command returned. The findings are source-backed and do not rely on Windows, exact `26.5.2`, signing, or external deployment evidence.
- The implementation checkpoint now adds a macOS process-group supervisor plus detached reaper, active-secret file/attachment guards, publication-command denial, and approval owner fencing. The strict native smoke covers detached-descendant normal completion and parent-loss cleanup. A fresh independent security review is still required; these remediation tests are implementation evidence, not approval.
- Remediation and a fresh macOS G2 review are required before enabling the normal composition root. Shell Auto and Shell Auto Debug remain disabled.

## WP1 checkpoint oversight

- The engineer owns only the implementation and deterministic evidence for WP1 `restricted-resource-loader`; the current scope is `packages/pi-adapter` plus the four WP1 documentation updates.
- The test agent independently re-runs the hostile `.pi` fixture and checks zero resource discovery, subprocess/network/install side effects, tool/command registration, prompt/session changes, and marker-file creation. The engineer's local 13/13 Pi Adapter result is not the QA decision.
- The WP1 contract fixture now injects a Candy-owned filesystem tripwire that records approved root `AGENTS.md` access and fails on any `.pi` read or enumeration. The full check is green outside the restricted shell; the restricted shell denies macOS `sandbox-exec` with `sandbox_apply: Operation not permitted` (exit `71`), while the same unchanged native runner probe succeeds outside it. This is scoped harness evidence only and does not clear G2 or platform acceptance.
- The architect reviewed the diff against the WP1 whitelist and acceptance/stop conditions and recorded Pass; independent hostile-fixture QA also recorded Pass. WP3 native-process and WP4 read-only tool reuse remain gated behind the active WP2 technical review and QA result.
- This checkpoint does not clear G2, platform acceptance, live-provider, signing, Browser, or final ACC-01..12 blockers.

## WP2 checkpoint oversight

- The WP2 implementation scope is limited to the TUI dependency/lockfile, boundary script, TUI surface/controller tests and sources, and the four checkpoint documents. `CandyTuiSurface` is the only direct `pi-tui` import surface; Candy remains the owner of commands, tasks, scheduling, Runtime calls, and sessions.
- The implementation rejects Pi debug/log environment variables, uses an explicit Candy app-data log directory, avoids `TuiMainScreen`, and redacts secret-shaped transcript output. FakeTerminal tests provide deterministic lifecycle evidence for normal exit, Ctrl+C, startup failure, and runtime failure.
- The architect must review the exact dependency allowlist, lifecycle restoration, and scope before the test agent performs independent macOS/Windows terminal QA. The deterministic checkpoint does not prove raw mode, paste, Chinese input, resize, IME, or cross-platform terminal recovery.
- WP3 native-process and WP4 read-only tool reuse remain gated until the WP2 technical review and independent QA result are published. Shell Auto and Shell Auto Debug remain disabled.

## 2026-08-13 TUI continuous-task checkpoint

- The deterministic TUI now keeps one explicit current task across ordinary follow-up prompts, exposes `:new` and `:use`, restores persisted task metadata/controllers, and records a bounded redacted transcript alongside the Candy-owned Pi session mapping.
- Active-owner overlap, cancelled-task continuation, stale revision, and non-owner control remain fail-closed in the TUI seam. This advances the implementation portion of `G1-PERSISTENCE`/`G0-MAC-RUNTIME`; it does not clear cross-client recovery or platform acceptance.
- Local deterministic evidence is 144/144 tests after the test-first checkpoint. Real macOS terminal recovery, Windows terminal evidence, live-provider coding journeys, and complete ACC-03/05/11 acceptance remain open. Shell Auto and Shell Auto Debug remain disabled.

## 2026-08-13 TUI workspace-browse checkpoint

- `candy_list` and `candy_search` now provide Candy-owned bounded directory listing and literal text search through Node filesystem APIs. Both Read-only and Auto include them; Pi built-in tools and Shell remain disabled unless the separately gated Trusted Shell path is explicitly selected.
- The tests cover workspace-relative containment, symlink/reparse-style fail-closed behavior, invalid/control text, ignored Candy app-data/dependency/cache directories, binary/invalid UTF-8 skipping, cancellation, result limits, tool schemas, and active-secret redaction. This clears only the deterministic adapter slice.
- No blocker is cleared by this checkpoint: real macOS/Windows terminal and cross-client evidence, provider/live-session evidence, G2 containment, full ACC-03/ACC-05/ACC-11, and final V1 acceptance remain open. Shell Auto and Shell Auto Debug stay disabled.

## 2026-08-13 macOS acceptance policy checkpoint

- The default macOS runner now accepts the current Tahoe `26.x` arm64 host at or above `26.5.2` and records the exact version. The exact `26.5.2` runner is explicit and writes a separate `baseline-latest.md` report.
- Current-host evidence is not retroactive proof of exact `26.5.2` behavior. Native containment, terminal, Keychain, Electron, recovery, and provider gates remain bounded by the host where they ran.
- On published revision `ace1c12fbd9115be34f66aca74107180499b5e4b`, the current MacBook Pro run on Tahoe `26.6.1` arm64 passed `21/21`; the report is `out/acceptance/macos/latest.md`. The exact-baseline command was also checked and blocked before execution on `26.6.1`, with separate evidence in `out/acceptance/macos/baseline-latest.md`.
- No product/security blocker is cleared by changing the evidence policy; it removes an unnecessary preflight block for current-host development while preserving the compatibility regression claim.

## 2026-08-13 TUI workspace-selection checkpoint

- `:workspace [absolute-path]` now lets the TUI choose an existing directory before creating a new task. The command rejects relative/control-character/non-directory paths, supports paths containing spaces, canonicalizes macOS `/var` aliases, and does not rewrite the workspace of an existing task.
- The real PTY journey starts from the temporary workspace parent, selects the workspace through this command, and verifies the persisted task workspace plus unchanged Git HEAD/index/commit state.
- No blocker is cleared: the current MacBook Pro reports macOS Tahoe `26.6.1`; this is current-host TUI Personal Preview evidence only, while exact `26.5.2` compatibility remains a separate baseline claim. Desktop remains lower priority in the active continuation, and Shell Auto/Shell Auto Debug stay disabled.

## Daily platform handoff boundary

## 2026-08-12 macOS live DeepSeek checkpoint

- The current macOS Gate is `Pass` for the DeepSeek provider matrix: `npm run gate:live:deepseek` returned exit code `0` and the sanitized report records `7 passed, 0 failed, 0 blocked` at source revision `7242b74f447f715ab1bd44ea684c63fefd74046b`.
- The run covered live Flash text, Flash tool replay, Pro thinking/tool replay, cancellation, controlled 401/429/timeout recovery, the session/fixture secret scan, and provider lease release. Flash and Pro expose reasoning deltas differently; the Gate keeps Flash's tool replay and Pro's thinking/tool replay obligations distinct. It used only the Candy-owned `candy-v1/deepseek` Keychain account and `https://api.deepseek.com`; MiniMax was not invoked.
- `G0-LIVE-MM` remains `Blocked` until the Candy-owned MiniMax Token Plan credential, live M3 matrix, and entitlement/account evidence are available. The DeepSeek matrix Pass does not change signed packaging, G2, Browser, complete ACC, Windows release, or final product-owner blockers.

## 2026-08-11 Windows release pipeline checkpoint

- Added `scripts/package-desktop-windows-release.mjs` and `scripts/verify-windows-release.mjs` plus `package:desktop:windows:release` and `verify:desktop:windows:release`. The packaging path requires the verified Electron override, builds the unsigned bundle, embeds the release native runner, writes the MSIX layout (`Candy.V1`, full trust) and PNG assets, signs every `.exe`/`.dll` with `signtool /fd SHA256`, packs and signs the MSIX, and verifies with `signtool verify /pa /all`; `release-metadata.json` records version, publisher, certificate thumbprint, source revision, lockfile digest, and the signed file list. The verify path runs install -> upgrade -> rollback -> uninstall while preserving an app-data marker across every phase, with authenticode validation and `Candy.exe` startup checks.
- Validation on this host: `node --check`, Prettier, and `git diff --check` pass. Signed packaging remains Blocked because no approved code-signing certificate with the Code Signing EKU and private key exists in the current-user or local-machine stores, and no PFX, `CANDY_*` signing env var, or Azure Trusted Signing configuration is available.
- The MiniMax gate was re-run at source revision `07ed455`: Token Plan entitlement is confirmed, but the Candy-owned `minimax-token-plan` credential is absent from Windows Credential Manager, so `LIVE-MM-01..05` remain Blocked at 0 ms with no network request; the sanitized report is `out/acceptance/live/minimax-cn-latest.md`.

- **MacBook Pro daytime:** implement and verify the current macOS Tahoe `26.x` Apple Silicon primary path. Run the exact `26.5.2` baseline only for that explicit compatibility claim. The macOS Git Task Worktree, Runtime/session-remap, source app-server recovery, and packaged Node/app-server recovery checkpoints are complete; the next active queue is ACC-12 responsiveness and remaining macOS-only deterministic evidence. Windows-only code and validation do not belong in this session.
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

## 2026-08-13 TUI file CRUD checkpoint

- The TUI now has an explicit File Auto profile. New Auto tasks receive the public Pi-backed Candy read/edit/write definitions plus a Candy-owned delete definition; Read-only tasks still receive only `candy_read`.
- `candy_delete` is not a Shell escape: it accepts one file path, requires an interactive TUI approval, rejects directories/symbolic links/workspace escape/control characters, and verifies that the approved regular file did not change before deletion. Cancellation and denial do not delete the file.
- This clears the deterministic TUI file-CRUD implementation gap only. Iterative turns, TUI model/MiniMax image selection, validators, diff/change review, packaged restart and ownership recovery, real-provider coding journeys, and real-terminal platform matrices remain open. G2 is unchanged, so Shell Auto and Shell Auto Debug remain disabled.

## 2026-08-13 TUI changes/diff/validator checkpoint

- The deterministic TUI implementation gap for workspace review and explicit validation is closed: `:changes`, bounded `:diff [path]`, explicit absolute-path validator configuration, pass/fail/cancel/timeout projection, cancellation, persisted redacted evidence, and native-unavailable `blocked` handling are covered by the shared Runtime/platform seams.
- The remaining blocker is evidence scope, not an automatic safety claim. The TUI still has no Shell path, automatic Apply/commit/stage/push path, or provider credential path in validator commands. Shell Auto and Shell Auto Debug remain disabled until the complete G2 evidence exists.
- Real macOS raw-terminal, Windows 11 terminal, live-provider coding, model/image selection, cross-client restart/handoff, complete ACC-03/05/11, OS-level command containment, and final V1 acceptance remain open.

## 2026-08-13 TUI model/attachment checkpoint

- The deterministic TUI model/image control gap is closed: `:model` accepts the three explicit model choices, persists canonical ids, rejects active/queued switches, routes MiniMax M3 to its dedicated provider engine, and never performs silent provider fallback.
- The deterministic attachment gap is closed for the TUI boundary: `:attach <absolute-path>` and `:attachments` use Candy-owned hashed storage, persist only ids/bounded metadata in task state, validate raster image bytes, and reject workspace/Candy app-data paths, symlinks, video, unsupported MIME, oversized/corrupt files, and credential-bearing content. A persisted MiniMax image attachment is recovered after restart; DeepSeek image use prompts an explicit MiniMax switch and is not auto-rerouted.
- Test-first local evidence is 155/155 repository tests, including typed domestic MiniMax image content, DeepSeek no-fallback, 401/429/timeout/cancelled redacted provider contracts, and attachment restart recovery. No new live provider call was made in this checkpoint.
- Remaining blocker boundary: real macOS/Windows terminals, complete Desktop attachment UX, live usage/entitlement evidence, G2 OS containment, full ACC-03/04/11, and final V1 acceptance remain open. Shell Auto and Shell Auto Debug remain disabled.

## 2026-08-13 TUI provider-failure recovery checkpoint

- The deterministic TUI provider-failure UX gap is closed: sanitized typed provider errors now expose only fixed safe categories, and interrupted tasks show explicit `:resume`, `:model`, and `:cancel` recovery actions. Paused/interrupted cancellation is revision-fenced and does not start another turn.
- The previous exact-version macOS acceptance runner did not produce a result on this host: it required macOS `26.5.2` arm64 and stopped before executing steps after observing macOS `26.6.1` arm64. That historical attempt was an environment mismatch, not a Pass/Fail result for ENV-MAC.
- Real `26.5.2` terminal evidence, Windows terminal evidence, live-provider coding journeys, complete ACC-03/04/11, G2, signing, and final V1 acceptance remain open.

## 2026-08-13 TUI real-PTY Personal Preview checkpoint

- The deterministic Expect-backed macOS PTY journey passes on the current arm64 host: two turns on one task, Candy workspace list/search/read/create/edit/delete tools, per-delete deny/approve, MiniMax M3 PNG attachment, changed-file/full-diff review, explicit `/usr/bin/true` native validator, Apply to Local, quit/restart transcript/task/model/attachment recovery, and terminal alternate-screen/cursor restoration.
- The journey also proves no workspace-external sentinel change, no Git index/HEAD/commit mutation, no automatic push, and no credential-shaped or synthetic-canary material in PTY/app-data/diff evidence or the parent Expect stdout/stderr capture. Shell Auto and Shell Auto Debug remain disabled.
- The current-host/baseline macOS runner writes a mode-specific current-HEAD sanitized `Blocked` preflight report when its selected target is unavailable and records that no acceptance step ran.
- Evidence boundary: current host is macOS Tahoe `26.6.1`; the PTY smoke is current-host evidence, not exact `26.5.2` regression evidence, and does not establish Windows terminal behavior, live-provider coding, G2 OS containment, signed packaging, complete ACC-03/04/05/11, or final V1 acceptance.

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
- The POSIX `ProcessSupervisor` is fail-closed around provider environment material and uses shell-free argument arrays. The macOS strict Seatbelt checkpoint now supplies deterministic containment evidence; Windows OS-level containment, packaging, and independent security review remain blocked under G2-SANDBOX/G2-NATIVE. Shell and Auto Debug remain `unsupported`.
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

## 2026-08-12 WP3 native-process boundary checkpoint

- The native-process refactor is complete within the approved scope: Runtime owns the platform-neutral `CommandRunner` port and common `CommandValidator`; Platform owns the JSONL v1 client, runner path resolution, environment/secret rejection, bounded output, and OS-specific cancellation; app-server performs only composition-root injection.
- No Rust crate, JSONL v1 field/version, native error code, no-network request, secret scrub contract, or cancellation result semantic was intentionally changed. The implementation checkpoint still requires full deterministic verification and independent QA before downstream work is accepted.
- `G2-SANDBOX`, `G2-PRIVILEGE`, `G0-WIN`, signing, live-provider, Browser, and final ACC blockers remain unchanged. Shell Auto and Shell Auto Debug stay disabled; this checkpoint does not authorize WP4 or any release activity.

## 2026-08-12 WP3 P1 nested JSON active-secret blocker

- Independent QA reproduced a credential boundary failure on `fdf6b453`: quote/backslash content embedded through nested JSON representations in an argument passed the previous TypeScript one-layer scan and executed in the real macOS sandbox child. Output redaction did not prevent execution, so the previous WP3 technical/QA closure is revoked.
- The first repair was additionally found to skip raw active-secret values larger than the v1 request-line limit, allowing a secret-bearing request to reach `spawnProcess`; the Rust size rejection occurs too late to enforce isolation.
- The current repair checks raw active-secret values unconditionally before spawn, then applies the bounded recursive JSON-representation guard only to subsequent representations. It must be independently verified against the saved nested fixture and oversized raw argument, including no child spawn and no workspace marker, before WP3 can leave `Blocked`.
- Do not start WP4. Windows 11 Job Object/native evidence remains Pending, and G2, Shell Auto, and Shell Auto Debug remain Blocked/disabled.

## 2026-08-12 Windows 11 non-admin deterministic seam repair

- The two Windows regressions in the deterministic suite are repaired without weakening the security boundary. The Pi hostile-workspace fixture uses a directory junction on ordinary Windows sessions, and the file-symlink contract uses the existing injectable filesystem seam; no assertion was skipped and `EPERM` is not treated as Pass. A separate real-symlink/reparse precondition smoke remains required and remains blocked without Developer Mode or equivalent authorization.
- Native runner path resolution now separates explicit override validation from module URL decoding and uses target-platform path semantics. Relative or nonexistent overrides fail closed; an incompatible host-shaped module URL cannot prevent a valid absolute override from being accepted.
- Windows 11 non-Administrator validation passed with `npm run check` at 126/126 tests, native Rust check, Job Object smoke, TUI task smoke, and app-server JSONL smoke. This clears the deterministic test-harness/path-resolution regression only and does not clear `G0-WIN`, `G2-SANDBOX`, `G2-PRIVILEGE`, signing, Browser, live-provider, complete recovery, or final ACC blockers.

## 2026-08-12 Windows current-HEAD acceptance evidence

- Current HEAD `b7cab12a8ecfd18d46c2813653e19dd978143ee4` has a clean sanitized `npm run acceptance:windows` report with 22/22 steps passing. It includes the unsigned packaged Desktop JSONL, packaged recovery, sequential handoff, long-running approval/steering, credential-isolation, coding-journey/transcript, Browser action/security, packaged Credential Manager, and ten-run responsiveness subset.
- The report's remaining blockers are unchanged and explicit: Windows signed installation; full existing-account Credential Manager lifecycle; OS-level no-network and arbitrary-command workspace containment, runtime reparse/race prevention, packaging, and independent security review; physical Browser input-origin and complete ACC-09/ACC-12; live MiniMax/Token Plan; remaining ACC-01..12 and product-owner acceptance. The 22/22 deterministic result must not be reported as complete V1 acceptance.
- No real provider credential, session, source upload, external tool configuration, or public provider request was used. Tomorrow's macOS work should continue from `b7cab12a8ecfd18d46c2813653e19dd978143ee4` after verifying the canonical branch SHA; macOS acceptance and live-provider evidence must be generated independently.

## 2026-08-13 Personal Preview implementation blockers

- **Fixed Git Bash executable unavailable:** the required `C:\Program Files\Git\bin\bash.exe` is not present on the current Windows host. Candy fails closed; no alternate Git installation path is used. This blocks live Pi Bash dogfooding, but not the deterministic adapter/approval/Worktree tests.
- **Security scope remains preview-only:** Personal Preview Shell uses the current Windows user's permissions. Job Objects provide process ownership and cancellation, not OS-level workspace or network containment. AppContainer/WFP, reparse/race hardening, independent security review, and Shell Auto/Shell Auto Debug remain blocked or disabled as documented above.

## 2026-08-13 WP4/WP5 result

- Windows deterministic acceptance remains green at **22/22** after the Personal Preview implementation, including unsigned packaged Desktop and responsiveness evidence. This does not clear the existing signing, live Provider, OS containment, Browser physical-input, independent-security-review, or final acceptance blockers.

## 2026-08-13 macOS MiniMax live gate checkpoint

- The macOS `26.5.2` arm64 MiniMax gate passed at source revision `44be499` after two fixes: `623aa13` moved the gate's `ONE_PIXEL_PNG` fixture constant above the top-level `await runGate(...)` (the previous placement made LIVE-MM-02 fail with a TDZ `ReferenceError` masked as `provider_error`), and `44be499` added the controlled 401/429/timeout MiniMax error-contract fixtures that mirror the DeepSeek path.
- Historical raw Gate summary: 7 passed, 0 failed, 1 blocked under the former `LIVE-MM-05` console-confirmation policy. LIVE-MM-01 text, LIVE-MM-02 image understanding, LIVE-MM-03 thinking/tool replay, LIVE-MM-04 cancellation, LIVE-MM-04 error contracts, secret-free-session, and secret-lease-release all passed against `https://api.minimaxi.com`.
- The current product policy supersedes that external-confirmation requirement: LIVE-MM-05 defaults to Pass and does not wait for provider-console plan, quota, balance, or usage-deduction evidence. The earlier product-owner console confirmation remains historical non-gating evidence.
- `G0-LIVE-MM` moves to Pass for the provider-matrix block; final ACC-04, MiniMax product-label enablement, and V1 release acceptance remain product-owner decisions and are unchanged.
