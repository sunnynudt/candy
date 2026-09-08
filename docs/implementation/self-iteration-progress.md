# Reliable self-iteration progress

Status: implementation in progress; this is the tracked handoff for the current release.

## P0 baseline

Captured on 2026-09-07 from revision `8c69e26c86c486306d11ed86c3aacd4b407f2beb` on macOS Tahoe `26.6.1` arm64.

| Item                  | Evidence                                                                                                                                           | Result  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Branch and remote     | `codex/candy-v1-foundation` matches `origin/codex/candy-v1-foundation` after fetch                                                                 | PASS    |
| Runtime baseline      | Node `22.23.2`, npm `10.9.8`, TypeScript `5.9.3`, Pi family checked by the repository assertion                                                    | PASS    |
| Lockfile              | `package-lock.json` SHA-256 `a5d7a3165c2b04551c36a8320fa856c4cf164d08411f6bcf3ef95dc80459f9ba`                                                         | PASS    |
| Existing user changes | `.gitignore`, `docs/product/candy-current-eli5.html`, and `docs/product/permission-experience-spec.md` preserved and excluded from this checkpoint | PASS    |
| Deterministic check   | `npm run check` stopped at the pre-existing Prettier failure in `apps/tui/src/slash-commands.ts`                                                   | PARTIAL |
| Windows 11            | No Windows host is available in this run                                                                                                           | NOT_RUN |
| Live providers        | No live-provider credential was used in this run                                                                                                   | NOT_RUN |

After the P0 edits, the latest deterministic checkpoint passed `npm run check`: 399 tests, format, lint, typecheck, boundary, Pi-version, and lifecycle checks all passed. The initial Prettier row above remains as the pre-change baseline observation.

## Latest verified launcher checkpoint

Source revision `3f0a9bc8a8c003cc336f96f634dd017de514e66c` is pushed and matches `origin/codex/candy-v1-foundation`. `npm run check` passes 400/400 after the launcher and WebUI lifecycle changes. `npm run smoke:tui:launcher` reports the current dirty checkout as `candidate`, including the exact revision, Node `22.23.2`, Pi `0.84.1`, and the stable upstream revision. A detached clean worktree at the same revision reports `channel=stable` under Node `22.23.2`; its printed recovery command uses a separate Git worktree and does not reset the active checkout.

At current revision `67e4d090d858b0a90ce7f5505d450932d481e77d`, `npm run candy -- --smoke` and the launcher smoke pass. A foreground `npm run webui` run returned `401` for unauthenticated API access, `403` for a token-bearing cross-site request, and `200` for authenticated HTML and `/app.js`; Chrome rendered the current task list, conversation, disabled non-owner Stop action, and bounded changed-files/diff view. The process was stopped in the foreground and left no daemon claim.

## Latest macOS acceptance checkpoint

Source revision `aad9d8a139e5f51458c64b848d3452cd29e4a9d4` is pushed and matches `origin/codex/candy-v1-foundation`. On macOS Tahoe `26.6.1` arm64 with Node `22.23.2` and npm `10.9.8`, `npm run acceptance:macos` passed 14/14 steps: full `npm run check` (400/400), native check, ten-run TUI responsiveness, launcher, credential presence/revocation, Pi/tool/coding/cancellation journeys, task smoke, macOS TUI journey, and terminal matrix. The image attachment journey now uses the explicitly image-capable `deepseek-v4-flash-vision-exp` model; MiniMax is not treated as an image-special model. This report is deterministic and uses controlled fixtures; it does not claim live provider, Windows, or real self-development dogfood evidence.

## Latest macOS current-scope revalidation

At source revision `3cfef263` immediately before checkpoint `95d5cb77b17bc5a15f0fc3fc9d2f60b3871e553c` (the checkpoint contains only acceptance-fixture/test changes), `npm run check` passed **401/401** and `npm run acceptance:macos` passed **14/14** on macOS Tahoe `26.6.1` arm64. The responsiveness report passed **10/10** samples, including cold start, visible event latency, cancellation, and three independent concurrent TUI clients. The concurrency fixture now reflects the foreground rule that `/new` rejects a still-active task; the full-suite review waits use a bounded 5-second window to avoid false failures under load. The checkpoint is pushed and matches `origin/codex/candy-v1-foundation`.

## Scope decisions

- Candy is model-neutral at the product boundary. DeepSeek and MiniMax domestic remain ordinary supported model paths; MiniMax stays on the domestic endpoint and never falls back globally. Image attachments follow the selected model's declared capability and never trigger provider handoff.
- The TUI remains the first local operator surface. A loopback WebUI is now in the current self-iteration release and shares Candy-owned tasks, history, ownership, redaction, and review rules.
- Electron Desktop, Browser Workspace, cloud execution, daemon behavior, detached execution, multi-agent orchestration, and plugin infrastructure remain outside this release.
- A WebUI tab is not an execution owner. A client may inspect persisted state without controlling another client's active task.

## Required evidence vocabulary

Every batch reports `PASS`, `PARTIAL`, `BLOCKED`, or `NOT_RUN` and separates source/test evidence from macOS interaction, Windows evidence, and live-provider evidence. A passing deterministic test does not substitute for a missing platform or live-provider gate.

## Current execution scope

The current development and acceptance scope is the macOS Tahoe `26.6.1` arm64 host. Windows 11 execution is intentionally deferred to the continuation on a Windows host and is not a blocker for the current macOS iteration. This scope decision does not weaken the formal V1 release contract: a future cross-platform release claim still requires Windows evidence.

## Batch status

| Batch                              | Status  | Current evidence                                                                                                                                                                                                                   |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 contract and baseline           | PASS    | This document and the product/acceptance contract updates                                                                                                                                                                          |
| P1 launch and stop                 | PASS    | Acceptance revision `aad9d8a`; launcher identity, `npm run candy -- --smoke`, Pi cancellation, Esc/session preservation, provider abort observation, and macOS 26.6.1 arm64 TUI journey pass |
| P2 new task and history            | PASS    | At source revision `3dabb94`, current-TUI `/new` rejects an active task until Esc settles it, then creates a distinct task; persistence, explicit continuation, task isolation, and history tests pass on macOS |
| P3 continuous execution and models | PARTIAL | Deterministic current-scope acceptance passes; the earlier real Candy-self-source pass remains valid at `6312f21`, but the current refresh is **BLOCKED** at the PTY assertion that reads persisted history after restart. DeepSeek/MiniMax live gates remain separate evidence; other configured models and Windows continuation are intentionally outside this run |
| P4 local WebUI                     | PARTIAL | Loopback server, shared task/history/review API, owner-fenced stop, foreground-process recovery, static operator UI, HTTP security tests, and current macOS Chrome rendering pass; Windows evidence and the formal release package remain pending |

## P2 new-task and same-directory policy

In the foreground TUI, `/new` is a fresh-task boundary. If the current TUI task is running or waiting for approval, Candy rejects the command and tells the user to press Esc, wait for the interrupted state, and then use `/new`. This prevents a new foreground task from silently leaving the previous task running in the background. The new-task regression test also verifies that the rejected command creates no task, and that after interruption the next `/new` creates a separate completed task.

Independent tasks may still execute concurrently through the bounded runtime and explicit operator controls. A safe Git task uses its own Candy-owned Task Worktree. A current-workspace task remains deliberately single-writer: if another queued, running, approval-waiting, or paused direct task targets the same workspace, creation is rejected with an actionable message to finish or cancel the older task first. Candy does not silently stop, merge, or interleave direct-workspace writers. The task list exposes state and workspace mode so the conflict is understandable.

This is the minimum behavior needed to keep foreground task context and writes separate without adding a new user permission choice. Parallel work remains available through isolated Task Worktrees when explicitly controlled outside the foreground `/new` shortcut.

## Local WebUI evidence

On macOS Tahoe `26.6.1` arm64, `npm run webui` started a foreground loopback server with a per-process bearer URL. Unauthenticated API access returned `401`; a token-bearing cross-site request returned `403`; authenticated HTML/API access returned `200`. Chrome rendered the task list, completed task state, Conversation transcript, disabled owner-fenced Stop control, and Changed files and diff view. The browser tab was closed with the foreground process; no daemon or user-data cleanup was introduced.

At source revision `6312f211728d845d88a1a163dddd2c77fee393f7`, the four WebUI contract tests also pass: shared task/history and bounded review data, owner-only stop, loopback-only binding, and foreground close interrupt with no replay. These are deterministic controller/server tests; the macOS browser rendering evidence above remains separately recorded.

At source revision `93fcb5fd28b9ef602b4ffd1c3668903f56817004`, a fresh `npm run webui` foreground run loaded the local task list in Chrome on macOS. The process was then stopped with Ctrl+C and did not remain as a daemon. This confirms current-HEAD browser rendering and foreground lifecycle; Windows WebUI evidence remains **NOT_RUN**.

At checkpoint `95d5cb77b17bc5a15f0fc3fc9d2f60b3871e553c`, a fresh foreground `npm run webui` run loaded the current persisted task list in Chrome. The current HTTP checks returned `401` for unauthenticated access, `200` for authenticated access, `403` for a token-bearing cross-site request, and `200` for the HTML page. The exact foreground process was stopped and the port was closed; no daemon remained. This is current macOS browser/auth/lifecycle evidence, not Windows or release-complete evidence.

## Latest real-provider and dogfood evidence

At source revision `e5d2ccddb05cb797516dbacde5e81f70bbc8a8c1` on macOS Tahoe `26.6.1` arm64 with Node `22.23.2` and npm `10.9.8`, the latest real DeepSeek live gate remains **7/7** through Candy's production Pi Agent Engine; the source-only revisions after `81c72cb` contain documentation changes, so the earlier passing acceptance remains valid. An earlier real Trusted Shell dogfood at source revision `14427683ff9232645ac77b8bfd069ed181d82bbe` also passed **3/3**: repository understanding, small repair, and failing-test diagnosis. All three Trusted Shell tasks used Candy-owned Task Worktrees; the Local Workspace, Git HEAD, Git index, and external sentinel remained unchanged, with zero safety failures and credential-free evidence. The sanitized reports are [DeepSeek live gate](../../out/acceptance/live/deepseek-latest.md) and [Trusted Shell dogfood](../../out/acceptance/macos/trusted-shell-auto-dogfood-latest.md).

The domestic MiniMax live gate at the current revision is **8/8**. Ordinary model text, tool/thinking replay, cancellation, error contracts, policy, and credential lifecycle scenarios pass through the production Pi Agent Engine. The gate no longer treats MiniMax image understanding as a provider-specific requirement. The endpoint remains `https://api.minimaxi.com`; no global fallback was used. See the [MiniMax live report](../../out/acceptance/live/minimax-cn-latest.md).

The MiniMax gate was rerun at source revision `aad9d8a139e5f51458c64b848d3452cd29e4a9d4`; it passed **8/8** using the ordinary model path. The previous image-only provider failure is no longer a required MiniMax gate because image attachments are capability-declared by the selected model rather than assigned to MiniMax.

The Candy-self-source development loop now passes on source revision `6312f211728d845d88a1a163dddd2c77fee393f7`: real DeepSeek and the production Candy Pi Agent Engine exercised Esc interruption during both a model stream and tool execution, continued both tasks explicitly, created a second task with `/new` in the same TUI, selected a clean Candy source checkout, discussed the runtime and acceptance constraints, modified only a Candy-owned Task Worktree, produced a controlled validator failure, repaired the file through an explicit continuation, passed revalidation, reviewed the diff, restarted, and switched historical tasks with `/tasks` and `/use`. The selected source workspace, Git HEAD/index/status, and an external sentinel remained unchanged; the sanitized report is [Candy self-development dogfood](../../out/acceptance/macos/candy-self-development-latest.md). This is macOS evidence only. Windows 11 evidence remains **NOT_RUN** and is intentionally deferred to the Windows-host continuation.

The current-refresh attempt at source revision `3cfef263` completed the model/tool interruption, continuation, task creation, repository discussion, modification, validator failure, repair, and review portions, but the PTY/Expect harness timed out while reading the persisted model-interruption task after restart. This is classified as **BLOCKED** evidence for the current revision: deterministic restart/history tests pass, but the refresh did not establish a current-HEAD end-to-end dogfood pass. The observed blocker is the interactive history readback assertion; it has not been treated as proof of runtime data loss, and the unverified harness workaround was not committed.

## Why the remaining scope is not complete

- The macOS implementation and deterministic acceptance are no longer the main gap: the current-scope check is **PASS** at 401/401 and the macOS acceptance is **PASS** at 14/14.
- The real self-development result needs a fresh current-revision evidence run. The prior end-to-end pass is at `6312f21`; the refresh is **BLOCKED** by the PTY history readback assertion after restart, so it cannot be promoted to current-HEAD evidence without a passing rerun.
- WebUI is implemented and has current macOS browser, authentication, loopback, and foreground-lifecycle evidence. The full P4 target still needs its formal evidence package and Windows-host evidence; it must not be inferred from the existing `apps/app-server` or from one browser smoke run.
- Windows 11 platform/native and cross-platform acceptance is **NOT_RUN** by explicit scope. It is an external host gate, not a macOS code task to silently mark complete.
- Product-owner approval and any live-provider run requiring credentials remain external gates. Other configured models are intentionally not expanded in this iteration.

The macOS code, deterministic tests, evidence updates, and bounded harness investigation can continue automatically. Windows acceptance, missing live credentials, and an explicit release-complete decision cannot be closed by local automation; they remain clearly recorded as **NOT_RUN** or **BLOCKED** until their required environment or decision exists.
