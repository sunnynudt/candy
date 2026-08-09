# Candy V1 Grilling Handoff

Updated: 2026-08-09

This document records the accepted product decisions and the remaining grilling frontier so another Codex session can continue without reconstructing the discussion. `docs/product/candy-v1.md`, `CONTEXT.md`, and accepted ADRs remain the source of truth when this handoff and a settled decision differ.

## Accepted decisions

### Product foundation

- Candy is a standalone, local-first, TypeScript-based coding product for macOS and Windows 11. It does not depend on Codex, OpenCode, or a separately installed Pi CLI.
- Candy is DeepSeek-first: DeepSeek V4 Flash is the default Primary Model, with DeepSeek V4 Pro and MiniMax M3 selectable per task.
- MiniMax M3 is a native multimodal Primary Model in V1, not a secondary vision-only service.
- Browser Workspace and Auto Debug are required V1 capabilities.
- Permissions, Local/Worktree behavior, browser identity, and long-running tasks follow Codex's public product behavior unless a Candy-specific security invariant is stricter.
- Pi is integrated through a narrow adapter without forking Pi, exposing Pi internal types, running Pi interactive mode, or rewriting the agent loop.
- Use exact Pi package versions and a lockfile. The latest stable npm version verified during planning was `0.84.1`; re-check the registry before a future upgrade.
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

- Pi exposes tool lifecycle events and hooks suitable for Candy permissions, status projection, and graceful stopping.
- Pi's tool execution mode defaults to parallel. Candy therefore needs an explicit policy: allow parallel side-effect-free tools while serializing mutations and shell commands inside a task.
- MiniMax M3 product material describes native image and video input, but Candy still needs to verify the domestic API's exact model identifier, multimodal message schema, tool calling, streaming, cancellation, and Token Plan authentication.
- A Token Plan MCP example that passes credentials through a child-process environment conflicts with Candy's credential-isolation invariant and must not be copied directly.

## Product grilling status

The V1 product frontier is closed. Model scope, Browser Workspace, Auto Debug, permissions, workspace behavior, browser identity, and long-running task behavior are accepted. Further work should treat these as architecture and compatibility questions rather than reopening product scope without new evidence.

## Remaining architecture frontier

### First vertical slice blockers

1. Select and pin the exact Node.js and package-manager versions.
2. Confirm the exact Pi packages and public entrypoints the narrow adapter imports.
3. Freeze the DeepSeek domestic API contract for V4 Flash and V4 Pro: approved host, model identifiers, authentication, thinking modes, streaming, and tool calling.
4. Define the first read-only tool fixture, workspace root, sandbox boundary, and approval expectation.
5. Define what loading the same session on macOS and Windows means and how both environments will be verified.
6. Resolve Desktop credential delivery: the app-server needs provider credentials while ordinary tools and child processes must never receive them.

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

1. Validate Electron's embedded browser plus CDP control path and determine whether an external automation package adds value behind the Browser Module.
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
7. this handoff

Then begin architecture design from the first vertical slice and narrow adapters. Do not reopen settled product scope unless a compatibility spike reveals a real contradiction.
