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

Source revision `6659ddc5e7ca6f78abb56ec95546930ad2e1857a` is pushed and matches `origin/codex/candy-v1-foundation`. On macOS Tahoe `26.6.1` arm64 with Node `22.23.2` and npm `10.9.8`, `npm run acceptance:macos` passed 14/14 steps: full `npm run check` (400/400), native check, ten-run TUI responsiveness, launcher, credential presence/revocation, Pi/tool/coding/cancellation journeys, task smoke, macOS TUI journey, and terminal matrix. This report is deterministic and uses controlled fixtures; it does not claim live provider, Windows, or real self-development dogfood evidence.

## Scope decisions

- Candy is model-neutral at the product boundary. DeepSeek and MiniMax domestic remain supported provider paths; MiniMax stays on the domestic endpoint and never falls back globally.
- The TUI remains the first local operator surface. A loopback WebUI is now in the current self-iteration release and shares Candy-owned tasks, history, ownership, redaction, and review rules.
- Electron Desktop, Browser Workspace, cloud execution, daemon behavior, detached execution, multi-agent orchestration, and plugin infrastructure remain outside this release.
- A WebUI tab is not an execution owner. A client may inspect persisted state without controlling another client's active task.

## Required evidence vocabulary

Every batch reports `PASS`, `PARTIAL`, `BLOCKED`, or `NOT_RUN` and separates source/test evidence from macOS interaction, Windows evidence, and live-provider evidence. A passing deterministic test does not substitute for a missing platform or live-provider gate.

## Batch status

| Batch                              | Status  | Current evidence                                                                                                                                                                                                                   |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 contract and baseline           | PASS    | This document and the product/acceptance contract updates                                                                                                                                                                          |
| P1 launch and stop                 | PASS    | Acceptance revision `6659ddc`; launcher identity, `npm run candy -- --smoke`, Pi cancellation, Esc/session preservation, provider abort observation, and macOS 26.6.1 arm64 TUI journey pass |
| P2 new task and history            | PARTIAL | Existing TUI tests cover `/new`, task isolation, persistence, explicit continuation; same-directory policy is documented below and shared WebUI state is implemented                                                               |
| P3 continuous execution and models | PARTIAL | Acceptance revision `6659ddc` passes bounded validator/model/cancellation and coding journeys; real DeepSeek Trusted Shell dogfood and Candy-self-source development now pass on macOS, but the complete live-provider matrix remains open |
| P4 local WebUI                     | PARTIAL | Loopback server, shared task/history/review API, owner-fenced stop, foreground-process recovery, static operator UI, HTTP security tests, and Chrome rendering on macOS pass; Windows evidence pending |

## P2 same-directory recommendation

`/new` always creates a distinct task in the current Candy interface. A safe Git task uses its own Candy-owned Task Worktree, so an older task may continue while the new task is queued or runs. A current-workspace task is deliberately single-writer: if another queued, running, approval-waiting, or paused direct task targets the same workspace, creation is rejected with an actionable message to finish or cancel the older task first. Candy does not silently stop, merge, or interleave direct-workspace writers. The task list exposes state and workspace mode so the conflict is understandable.

This is the minimum behavior needed to keep task context and writes separate without adding a new user permission choice. Parallel work remains available through isolated Task Worktrees.

## Local WebUI evidence

On macOS Tahoe `26.6.1` arm64, `npm run webui` started a foreground loopback server with a per-process bearer URL. Unauthenticated API access returned `401`; a token-bearing cross-site request returned `403`; authenticated HTML/API access returned `200`. Chrome rendered the task list, completed task state, Conversation transcript, disabled owner-fenced Stop control, and Changed files and diff view. The browser tab was closed with the foreground process; no daemon or user-data cleanup was introduced.

## Latest real-provider and dogfood evidence

At source revision `14427683ff9232645ac77b8bfd069ed181d82bbe` on macOS Tahoe `26.6.1` arm64 with Node `22.23.2` and npm `10.9.8`, the real DeepSeek live gate passes **7/7** through Candy's production Pi Agent Engine. The real Trusted Shell dogfood also passes **3/3**: repository understanding, small repair, and failing-test diagnosis. All three tasks used Candy-owned Task Worktrees; the Local Workspace, Git HEAD, Git index, and external sentinel remained unchanged, with zero safety failures and credential-free evidence. The sanitized reports are [DeepSeek live gate](../../out/acceptance/live/deepseek-latest.md) and [Trusted Shell dogfood](../../out/acceptance/macos/trusted-shell-auto-dogfood-latest.md).

The domestic MiniMax live gate at the same revision is **7/8**. Text, thinking/tool, cancellation, error contracts, policy, and credential lifecycle scenarios pass; the mandatory image scenario fails after bounded retry with a sanitized `provider_error`/`network_error`. The endpoint remains `https://api.minimaxi.com`; no global fallback was used. This is currently an open live-provider blocker, not a source-level pass. See the [MiniMax live report](../../out/acceptance/live/minimax-cn-latest.md).

The MiniMax gate was independently retried after the latest checkpoint at source revision `0b8d4fc0337a6e265058df60f8b37ab2eca1c20f`; it remains **7/8** with the same mandatory image `provider_error` after bounded retry. This confirms the open item is still an external provider/image-path gate rather than a deterministic Candy test failure.

The Candy-self-source development loop now passes on source revision `9c2aec834f674124aa316cf66f7c4fcbcdb8a7d1`: real DeepSeek and the production Candy Pi Agent Engine selected a clean Candy source checkout, discussed the runtime and acceptance constraints, modified only a Candy-owned Task Worktree, produced a controlled validator failure, repaired the file through an explicit continuation, passed revalidation, reviewed the diff, restarted, and recovered the task history. The selected source workspace, Git HEAD/index/status, and an external sentinel remained unchanged; the sanitized report is [Candy self-development dogfood](../../out/acceptance/macos/candy-self-development-latest.md). This is macOS evidence only. Windows 11 evidence remains **NOT_RUN** because no Windows host is available.
