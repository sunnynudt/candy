# Candy V1 Grilling Handoff

Updated: 2026-08-09

This document records the accepted product decisions and the remaining grilling frontier so another Codex session can continue without reconstructing the discussion. `docs/product/candy-v1.md`, `CONTEXT.md`, and accepted ADRs remain the source of truth when this handoff and a settled decision differ.

Scope note (2026-08-17): this is a historical handoff snapshot. The current V1 contract is the TUI-only scope in [`candy-v1.md`](candy-v1.md) and [`acceptance-v1.md`](acceptance-v1.md); Desktop, Browser Workspace, and their dependent workflows are V2 and the older requirements below are not V1 acceptance criteria.

## Accepted decisions

### Product foundation

- Candy is a standalone, local-first coding product for the current macOS Tahoe `26.x` on Apple Silicon and Windows 11. The current primary host is `26.6.1`. Product and control-plane code is TypeScript, with one audited Rust native-helper exception for OS command containment and Windows process-tree ownership.
- Candy is DeepSeek-first: DeepSeek V4 Flash is the default Primary Model, with DeepSeek V4 Pro and MiniMax M3 selectable per task.
- MiniMax M3 is a native multimodal Primary Model in V1, not a secondary vision-only service.
- Browser Workspace and Auto Debug are required V1 capabilities.
- Permissions, Local/Worktree behavior, browser identity, and long-running tasks follow Codex's public product behavior unless a Candy-specific security invariant is stricter.
- Pi is integrated through a narrow adapter without forking Pi, exposing Pi internal types, running Pi interactive mode, or rewriting the agent loop.
- Pi `0.84.1` is the agent-runtime compatibility anchor. Use the Pi-tested Node 22 line, TypeScript `5.9.3`, npm's lockfile-v3 workflow, and an exact unmixed Pi package closure; upgrade these as one compatibility train.
- The first vertical slice remains intentionally small and must pass before full TUI or Electron work begins.

### Bounded parallel tasks

- A Candy Task has one agent, one session, and one execution owner.
- Multiple independent tasks may run concurrently. Multi-agent collaboration inside one task is not part of V1.
- Default concurrency is three tasks; the V1 hard limit is five.
- Tasks beyond the limit enter a FIFO queue that the user may reorder or cancel.
- DeepSeek and MiniMax have independent provider concurrency gates and fair rate limiting. A provider `429` pauses that provider without blocking unrelated local tools.
- Side-effect-free reads and searches may run in parallel inside one task. File mutations and shell commands are sequential by default inside that task.
- Concurrent writable tasks for the same repository use separate Git worktrees.
- Completed worktrees remain until the user applies or discards them.
- Applying changes requires diff review and produces uncommitted changes in the target workspace. Candy never auto-commits. Dirty targets and conflicts stop for user review.
- Closing the Desktop window leaves Candy running in the tray or menu bar. Explicitly quitting Candy prompts and cancels running tasks. No task survives application exit.

### Model portfolio and multimodal input

- Each task has one Primary Model and may switch only between turns.
- DeepSeek V4 Flash is the default; DeepSeek V4 Pro is the higher-capability DeepSeek option.
- MiniMax M3 accepts text and images natively and may control the normal agent loop and tools.
- DeepSeek image attachment prompts an explicit switch to MiniMax M3; Candy does not perform a hidden vision handoff.
- All MiniMax requests, attachments, and credentials are restricted to `https://api.minimaxi.com`; there is no global-site fallback.
- V1 requires pasted images, image files, and browser screenshots. Video remains gated on domestic API and Token Plan verification.

### Codex-style local control baseline

- Default Auto permissions allow reads, edits, and commands inside the active workspace; Read-only mode is available.
- Network access, workspace escape, destructive actions, commits, pushes, releases, deployments, and sensitive browser actions require approval. V1 has no sandbox bypass mode.
- Git tasks may run in Local or a task-associated Worktree and use Handoff. Non-Git projects run directly and permit one writable task.
- Candy Browser uses its own persistent profile, per-site permission, and sensitive-action confirmation. Automated file upload is excluded from V1.
- Long-running tasks define outcome and verification criteria, support pause/resume/steering, and retain the same permissions. Auto Debug is a specialization of this task behavior.

## Verified implementation facts

- The accepted architecture, conditionally accepted [technical plan](../architecture/technical-plan-v1.md), staged [coding implementation plan](../architecture/implementation-plan-v1.md), and Gate reports now exist. Product coding has not started.
- Pi `0.84.1` publishes a documented coding-agent SDK root export and exposes tool lifecycle events and hooks suitable for Candy permissions, status projection, and graceful stopping.
- Pi's tool execution mode defaults to parallel. Candy therefore needs an explicit policy: allow parallel side-effect-free tools while serializing mutations and shell commands inside a task.
- DeepSeek's verified API model identifiers are `deepseek-v4-flash` and `deepseek-v4-pro`, both through the domestic Chat Completions path. MiniMax's verified model identifier is `MiniMax-M3`; Pi's domestic provider route uses the Anthropic-compatible endpoint.
- MiniMax M3's static contract covers native image and video input, but Pi `0.84.1` public types support only text and image. Candy V1 video therefore remains disabled. Text/image, thinking/tool replay, cancellation, and the supplied Token Plan account entitlement still require real-credential tests.
- A Token Plan MCP example that passes credentials through a child-process environment conflicts with Candy's credential-isolation invariant and must not be copied directly.
- Browser Workspace has a selected implementation path: Electron `WebContentsView`, a persistent Electron Session, `DownloadItem`, and a narrow `webContents.debugger`/CDP Adapter. Playwright is an external test tool; agent-browser and browser-use are not V1 production dependencies.
- Candy has accepted one audited Rust Sandbox Runner as the only exception to the TypeScript product/control-plane rule. It owns OS containment and Windows Job Object process trees only; ADR-0010 permits the macOS TUI Trusted Shell Auto Personal Preview while platform-specific G2, security review, and release acceptance remain separate gates.
- Automatic Browser takeover remains preferred. A visible Take Control action is the accepted fallback when packaged Electron cannot reliably distinguish physical input from CDP-synthesized input.
- V1 completeness is now defined by `docs/product/acceptance-v1.md`; passing implementation tests without the mapped product, security, recovery, live-provider, and platform evidence is insufficient.
- Real DeepSeek/MiniMax tests follow `docs/testing/live-provider-credentials.md`. Claude Code/OpenCode configuration may supply redacted discovery evidence but is not a Candy credential source.
- The Pi-compatible baseline is Node `22.23.2`, bundled npm `10.9.8`, TypeScript `5.9.3`, and every `@earendil-works/pi-*` package at exact `0.84.1`. Desktop app-server packages the same Node runtime; Electron's embedded Node is confined to Desktop responsibilities.

## Product grilling status

The V1 product frontier is closed. Model scope, Browser Workspace, Auto Debug, permissions, workspace behavior, browser identity, and long-running task behavior are accepted. Further work should treat these as architecture and compatibility questions rather than reopening product scope without new evidence.

## Remaining implementation and verification frontier

Detailed evidence and pass conditions are in [Compatibility Gate 0](../research/compatibility-gate-0.md) and [Platform Gate 0](../research/platform-gate-0.md). The coding order is in the [implementation plan](../architecture/implementation-plan-v1.md).

### First vertical slice Gates and verification work

1. Pi-compatible Gate baseline selected: agent runtime Node.js `22.23.2`, bundled npm `10.9.8`, TypeScript `5.9.3`, complete Pi closure `0.84.1`, and Electron `43.2.0`; clean install, install-tree, two-OS, and signed-package smoke tests remain.
2. Pi Adapter contract selected: `@earendil-works/pi-coding-agent@0.84.1` documented root SDK export only; real two-OS import/session smoke remains.
3. DeepSeek static contract is frozen; real Flash/Pro credentials, thinking/tool replay, cancellation, rate-limit, and secret-redaction smoke remain.
4. The first read-only fixture is a Candy-owned TypeScript workspace under `fixtures/read-only-workspace`. The allowed root is that fixture directory; an in-root read requires no approval, while traversal, symlink/reparse escape, mutation, and Shell are rejected rather than escalated.
5. Cross-platform session loading means reopening Candy-owned session data after an explicit workspace remap; absolute paths are not portable. Windows and macOS execute the same fixture and compare normalized session events rather than native path strings.
6. Credential backend selected conditionally as `@napi-rs/keyring@1.3.0`; signed current macOS Tahoe `26.x` Apple Silicon/Windows 11 package loading and secret non-propagation remain to be proved.
7. The current macOS Tahoe `26.x` Apple Silicon host is the primary target. The narrow Rust Sandbox Runner path and explicit Browser takeover fallback are accepted in ADR-0005, ADR-0006, and ADR-0009.

### Task, workspace, and recovery architecture

1. Define how the TUI and Desktop coordinate independent task execution without sharing one task's owner.
2. Persist queued, paused, and interrupted states without silently resuming after application restart.
3. Specify task lock location, stale-lock recovery, worktree naming, Handoff operations, and cleanup on macOS and Windows.
4. Define change tracking and review for a directly edited non-Git Local Workspace.

### Provider and attachment compatibility spikes

1. Verify the MiniMax domestic API or SDK for M3, including the exact model identifier and Token Plan authentication path.
2. Keep provider calls in a trusted in-process adapter; do not expose credentials to ordinary MCP or tool subprocesses.
3. Define the provider-neutral message, tool-call, attachment, and session-retention contracts.
4. Verify image formats, size limits, streaming, tool calling, cancellation, rate limiting, and failures against the domestic endpoint.
5. Verify video support separately before enabling its UI.

### Browser compatibility spike

1. Validate the selected Electron `WebContentsView` plus `webContents.debugger` control path in a packaged spike; production does not depend on an external automation package.
2. Define observation revisions, element references, user takeover, cancellation, site permission, and sensitive-action events.
3. Define persistent-profile storage, browsing-data controls, visible downloads, and the V1 prohibition on automated uploads.
4. Connect browser screenshots and rendered evidence to MiniMax M3 without exposing browser credentials.
5. Treat WeChat articles as ordinary Browser Workspace pages with manual login and user-visible handoff; do not build a site-specific anti-bot bypass.

### Long-running task and Auto Debug architecture

1. Reuse Pi's agent loop and Candy's normalized events rather than adding a workflow engine.
2. Define the validator contract, progress evidence, stall detection, optional budgets, and stop reasons.
3. Define pause, resume, steering, tray execution, explicit-quit cancellation, and crash recovery.
4. Ensure long-running execution never broadens existing workspace, command, network, browser, or provider permissions.

## Recommended next session start

Read, in order:

1. `AGENTS.md`
2. `CONTEXT.md`
3. `docs/product/candy-v1.md`
4. `docs/adr/0001-bounded-parallel-tasks.md`
5. `docs/adr/0003-deepseek-first-multimodal-model-portfolio.md`
6. `docs/adr/0004-codex-style-local-control-baseline.md`
7. `docs/adr/0005-allow-narrow-native-sandbox-runner.md`
8. `docs/adr/0006-use-explicit-browser-takeover-fallback.md`
9. `docs/adr/0008-target-current-macos-26-5-2.md`
10. `docs/research/compatibility-gate-0.md`
11. `docs/research/pi-toolchain-baseline.md`
12. `docs/research/platform-gate-0.md`
13. `docs/architecture/technical-plan-v1.md`
14. `docs/architecture/implementation-plan-v1.md`
15. `docs/product/acceptance-v1.md`
16. `docs/testing/live-provider-credentials.md`
17. this handoff

Architecture decisions are complete and product coding is authorized. Continue the coding implementation plan while keeping unresolved live/platform capabilities unavailable and recorded as Blocked. Do not reopen settled product scope without a real compatibility contradiction, and do not claim a slice complete without its mapped acceptance evidence.
