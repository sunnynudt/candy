# Candy V1

## Product statement

Candy is a standalone, DeepSeek-first coding product for the current macOS Tahoe `26.x` Apple Silicon host and Windows 11. The primary macOS host is currently `26.6.1`; exact macOS `26.5.2` compatibility remains a separately tracked regression baseline. Candy uses domestic models to provide a Codex-class core coding loop without requiring Codex, OpenCode, or a separately installed Pi CLI. Each task has one agent, while multiple independent tasks may run concurrently within a bounded limit.

It provides:

- a terminal UI for direct coding interaction;
- an Electron desktop client for session management, permissions, tool visibility, changed files, and diff review;
- a task-bound browser for shared user and agent web interaction;
- long-running tasks and Auto Debug with explicit verification criteria;
- a shared TypeScript runtime implemented through a Pi SDK adapter.

Candy V1 validates a useful product slice. It does not attempt complete feature parity with mature coding agents.

## V1 boundaries

Candy V1 is:

- local-first;
- single-user;
- single-agent per task;
- bounded to three concurrent tasks by default and five at most;
- TypeScript for product and control-plane code, with one audited Rust native-helper exception for OS command sandboxing and Windows process-tree ownership;
- BYOK for DeepSeek and MiniMax domestic Token Plan;
- supported on the current macOS Tahoe `26.x` Apple Silicon host and Windows 11; the exact host version is recorded in acceptance evidence.

Candy V1 does not include:

- a Candy cloud backend;
- Candy accounts, subscriptions, or model billing;
- credential synchronization;
- a system-wide daemon;
- multi-agent orchestration;
- detached task execution after Candy quits;
- remote execution;
- a plugin marketplace;
- a general workflow engine;
- real-time control from multiple clients.

## Runtime topology

### TUI

```text
Candy TUI
  -> @candy/runtime
  -> Pi SDK adapter
  -> selected Primary Model
```

The TUI runs the runtime in-process. The WP2 vertical slice now uses the exact direct dependency `@earendil-works/pi-tui@0.84.1` only for the editor, transcript widgets, and rendering surface. Candy retains command parsing, task state, scheduling, Runtime calls, and session ownership; it does not run Pi interactive mode or import Pi's client, protocol, plugin, or session-store surfaces. The slice uses `TuiAltScreen` and `ProcessTerminal`, rejects `PI_TUI_WRITE_LOG`, `PI_TUI_DEBUG`, and `PI_DEBUG_REDRAW`, writes to an explicit Candy app-data log directory, and redacts secret-shaped transcript output. Deterministic FakeTerminal coverage is an implementation checkpoint, not macOS/Windows terminal acceptance.

### Desktop

```text
Electron Renderer
  -> Electron IPC
  -> Electron Main
  -> typed JSONL over stdio
  -> Candy app-server child process
  -> bounded task scheduler
  -> per-task @candy/runtime instance
  -> Pi SDK adapter
  -> selected Primary Model
```

The app-server is owned by the Desktop application. It must not outlive the application and is not a cloud server or system-wide daemon.

## Shared runtime

TUI and Desktop use the same `@candy/runtime` package.

The runtime owns, per task:

- Pi SDK integration;
- DeepSeek and MiniMax provider configuration;
- tool execution policy;
- permission requests;
- session loading and saving;
- normalized runtime events.

Clients own presentation and user interaction.

## Tasks and sessions

Each Candy Task has one agent and one persistent session. V1 reuses Pi session machinery and format in a Candy-owned application-data directory resolved by a platform adapter.

Candy must not write into Pi's default session directory.

TUI and Desktop may view and sequentially resume the same task. They may not simultaneously control one task's active turn. Independent tasks may run concurrently within the global limit.

## Execution ownership

Each task permits only one active execution owner. Candy may hold multiple task execution locks at once, up to the configured concurrency limit.

The execution lock contains:

```json
{
  "taskId": "...",
  "sessionId": "...",
  "ownerPid": 1234,
  "ownerType": "tui",
  "acquiredAt": "..."
}
```

A client without a task's lock may inspect that task's saved state but cannot start or continue its execution.

Normal task exit releases its lock. Crash recovery must detect stale locks safely on the current macOS Tahoe `26.x` Apple Silicon host and Windows 11; the exact `26.5.2` regression baseline remains separately tracked.

Cross-client continuation means:

1. stop or finish the current turn;
2. wait for active tools to stop;
3. persist completed messages and results;
4. release the execution lock;
5. start a new turn from another client.

V1 does not migrate an in-flight tool call between processes.

## Parallel task scheduling

Candy runs three tasks concurrently by default and enforces a V1 hard limit of five. Additional tasks enter a FIFO queue that users may reorder or cancel.

Provider calls use independent global concurrency gates and rate limiters for DeepSeek and MiniMax. Scheduling is fair across tasks. A provider rate limit pauses calls to that provider without blocking unrelated local tools.

Candy exposes two Git workspace environments: Local Workspace for direct foreground work and Task Worktree for parallel or background work. A task may start in either environment and may use Workspace Handoff to move between its Local Workspace and associated Task Worktree. Concurrent writable tasks for the same repository must use separate Task Worktrees.

A Task Worktree stays associated with its task until the user applies or discards it. Applying changes requires diff review and transfers the patch into the Local Workspace as uncommitted changes. Candy does not automatically commit. A dirty Local Workspace or patch conflict stops the handoff for user review.

Non-Git projects run directly in their Local Workspace and support at most one writable task at a time. Candy does not initialize Git without an explicit user request, and non-Git projects do not offer Task Worktrees or Workspace Handoff.

Closing the Desktop window keeps Candy and its app-server running in the tray or menu bar. Explicitly quitting Candy prompts the user and cancels running tasks. V1 does not continue execution after the Candy application exits.

## Pi integration

Candy depends on Pi through a narrow adapter.

V1 does not:

- fork Pi;
- expose Pi internal types to clients;
- run Pi interactive mode;
- rewrite the agent loop;
- promise compatibility with the full Pi extension ecosystem.

The WP1 source boundary is now enforced in the Pi Adapter: `PiAgentEngine` supplies a Candy-owned `CandyRestrictedResourceLoader` and an in-memory `SettingsManager` with `projectTrusted: false`. The loader never discovers or reloads Pi resources, exposes empty extensions/skills/prompts/themes, rejects non-empty resource extension requests, and reads only a bounded, non-symlink root `AGENTS.md` after credential redaction. `.pi` settings, packages, extensions, skills, prompts, themes, and executable resources are outside the Candy session boundary. The deterministic hostile-workspace fixture proves this behavior and is not macOS/Windows platform acceptance or a final release-security Pass.

WP2 keeps that boundary at the presentation seam: `CandyTuiSurface` is the only TUI module that imports `pi-tui`, and the `InteractiveTui` remains the product control plane. Its injected terminal seam restores input, cursor, and terminal state on normal exit, Ctrl+C, startup failure, and runtime failure. The explicit log path and output redaction protect the TUI surface from the Pi default debug/crash destinations and credential-shaped values; real terminal behavior still requires the supported macOS and Windows acceptance matrices.

Pin the complete Pi package family to exact `0.84.1` and verify session behavior on both supported operating systems. Pi is the agent-runtime compatibility anchor: Node stays on Pi's tested Node 22 line, TypeScript matches Pi `5.9.3`, and npm follows the selected Node distribution and Pi's lockfile workflow. Pi and these boundary-sensitive toolchain versions upgrade as one compatibility change, never as independent freshness updates.

## Tool boundary

V1 reuses Pi's basic tool implementations behind a thin Candy Tool Host.

The Tool Host provides:

- permission checks;
- secret isolation;
- normalized tool events;
- command cancellation;
- file-change tracking;
- structured errors.

V1 initially uses Pi's existing file and shell tools. Additional editing tools are deferred until real usage demonstrates a need.

Side-effect-free reads and searches may execute in parallel within one task. File mutations and shell commands execute sequentially within that task by default. Parallel execution across independent task worktrees is allowed.

## Permissions and sandboxing

Candy follows a two-layer local control model:

- sandbox policy defines what a model-generated action can technically access;
- approval policy defines when Candy must pause and ask the user.

The default Auto profile permits reading, editing, and running commands inside the active workspace. Model-generated commands have no network access by default. Writing outside the workspace, enabling command network access, destructive actions, credential access, commits, pushes, releases, deployments, and other external side effects require approval. A Read-only profile supports analysis without modifications. V1 does not expose a mode that bypasses both approvals and sandboxing.

Strong command containment is implemented through the narrow native Sandbox Runner accepted in ADR-0005. It owns only OS sandbox and process-tree mechanics; Candy's task, approval, provider, workspace, and product policies remain in the TypeScript Runtime. Shell-enabled Auto and Shell-based Auto Debug remain unavailable on a platform until its native backend passes the required security and cancellation gates.

Provider HTTPS requests run through privileged provider adapters and are not ordinary tool-network access. Provider credentials are never inherited by tools, commands, browser processes, or browser pages.

## Model portfolio and multimodal input

Each Candy Task has one selected Primary Model. V1 supports:

- DeepSeek V4 Flash as the default model for speed and cost;
- DeepSeek V4 Pro as the higher-capability DeepSeek option;
- MiniMax M3 as a native multimodal coding model for text and image input.

Users may switch the Primary Model between turns, but Candy does not change providers during an active turn and never performs a silent cross-provider fallback. When a user attaches an image to a DeepSeek task, Candy offers to switch the task to MiniMax M3 rather than sending the image through a hidden secondary vision call.

V1 supports pasted images, dragged image files, selected image files, and browser screenshots. Attachments are stored in Candy's application-data directory; sessions record attachment identifiers and metadata rather than embedding binary data. The attachment model may represent video, but the video input UI remains disabled until the MiniMax domestic API contract, limits, cancellation behavior, and Token Plan eligibility are verified.

Candy sends MiniMax requests and multimodal attachments only to `https://api.minimaxi.com`. It must not fail over to the global MiniMax endpoint. A MiniMax failure is explicit and offers retry, model change, or cancellation.

## Browser Workspace

The Desktop client provides a visible, task-bound Browser Workspace shared by the user and agent. V1 supports opening pages, navigating, clicking, typing, inspecting rendered state, taking screenshots, and verifying local or public web pages. It reuses an existing Chromium automation surface; Candy does not implement a browser engine.

The built-in browser uses a Candy-owned persistent Browser Profile that is separate from the user's regular browser and provider credentials. The user signs in directly when an account is required and may clear browser data in Settings. Candy never exposes complete cookie, password, or token values to the model, session, tools, or logs.

The user must allow a site before the agent can operate it. Site permission does not make page content trusted. Submitting information, purchasing, changing permissions, deleting data, publishing content, or using full browser-debug access requires explicit confirmation. Automated file upload is not included in V1. Downloads use a user-configured location and remain visible to the user.

Candy uses a single Browser Control Owner per tab. When packaged Electron can reliably identify physical user interaction, that interaction immediately returns control to the user and cancels or pauses the conflicting agent action. Otherwise V1 presents a visible Take Control action that performs the same transfer before the user operates the page. The agent cannot silently retake control.

## Long-running tasks and Auto Debug

A Long-running Task starts from an explicit outcome, constraints, and verification criteria. Users may pause, resume, steer, or cancel it while Candy runs. Closing the Desktop window may leave it running in the tray or menu bar; explicitly quitting Candy cancels it. Long-running execution never broadens the task's sandbox, approvals, workspace, model, or browser permissions.

Auto Debug is a Long-running Task that reuses Pi's agent loop and Candy's normal tools. It gathers observable failure evidence, edits the project, reruns the same validator, and stops when verification succeeds or execution cannot safely continue. Validators may be tests, builds, explicit commands, or browser-visible assertions.

Command and build validators use Candy's common `CommandValidator` for bounded, redacted evidence and completion semantics. The platform adapter owns only the native process boundary: the existing versioned JSONL contract, no-network request, runner location, and macOS/Windows cancellation strategy. This separation does not enable Shell Auto or Shell Auto Debug; those remain disabled until the independent G2 evidence passes on both platforms.

Candy pauses Auto Debug when it needs a new approval, detects repeated lack of progress, reaches an optional user budget, loses its execution owner, or receives a user stop. It never auto-commits, pushes, releases, deploys, or creates a second workflow engine.

## V1 product value

Candy V1 focuses on:

- TUI and Desktop access to the same persistent sessions;
- standalone DeepSeek-first setup with selectable DeepSeek V4 Flash, DeepSeek V4 Pro, and MiniMax M3;
- desktop session management;
- structured tool visibility;
- permission approval;
- changed-file presentation;
- diff review;
- cross-client sequential continuation;
- bounded parallel tasks with Local/Worktree handoff;
- native MiniMax M3 image understanding;
- shared user/agent browser verification;
- long-running tasks and Auto Debug with explicit completion criteria.

Tool count is not a V1 differentiator.

## Credentials

Users provide their own DeepSeek and MiniMax domestic Token Plan credentials for the models they enable.

Allowed credential sources:

- a temporary provider-specific process environment;
- the local operating-system credential store.

Credential resolution order:

1. temporary process environment;
2. local credential store;
3. `needs_credentials`.

Provider credentials must be removed from environments passed to tools and child processes. Before a native validator starts, Candy unconditionally rejects raw active credentials in executable, arguments, paths, and environment entries; it also rejects their repeatedly JSON-stringified representations while each representation fits the native v1 request-line limit. The raw value is never exempt because it exceeds that limit, and redacting returned output is not a substitute for preventing execution.

Credentials must never appear in:

- repositories;
- sessions;
- prompts;
- model-visible context;
- logs;
- diagnostics;
- analytics;
- crash uploads;
- JSONL command/event messages;
- tool subprocesses.

Each provider credential may authenticate only to its approved HTTPS endpoint. All MiniMax credentials, model requests, and multimodal attachments are restricted to `https://api.minimaxi.com`.

Candy V1 has no remote telemetry or automatic crash upload.

## V1 acceptance

[Candy V1 Product Acceptance Standard](./acceptance-v1.md) is the authoritative definition of complete. Each implementation slice must pass its mapped Acceptance Gates with reviewable evidence on the current macOS Tahoe `26.x` Apple Silicon primary host and Windows 11. The exact `26.5.2` matrix is a separate compatibility regression gate when that compatibility claim is required. V1 release requires every mandatory product journey, live provider contract, security invariant, recovery case, and responsiveness target to pass with zero open P0/P1 defects.

Real provider tests follow the [Live Provider Credential Procedure](../testing/live-provider-credentials.md). Existing Claude Code or OpenCode configurations may be inspected only through a user-authorized redacted audit; Candy never treats them as runtime credential sources or automatically imports their tokens.

## First vertical slice

Implement and verify only:

1. initialize the TypeScript workspace;
2. pin the Pi-compatible Gate baseline: Node.js `22.23.2`, bundled npm `10.9.8`, TypeScript `5.9.3`, and every resolved `@earendil-works/pi-*` package at exact `0.84.1`, while importing only the documented coding-agent root SDK export;
3. run one `deepseek-v4-flash` prompt through `https://api.deepseek.com/chat/completions` and the Pi SDK;
4. stream the response;
5. execute one read-only tool call;
6. persist the session in Candy's application-data directory;
7. load the same session on the current macOS Tahoe `26.x` Apple Silicon host and Windows 11;
8. verify the credential does not enter logs, sessions, tool subprocesses, or the repository.

Do not start the full TUI or Electron UI before this slice passes.

Do not start the parallel scheduler, worktree flow, MiniMax M3 integration, Browser Workspace, or Auto Debug before this slice passes. These remain required V1 capabilities and follow as later vertical slices.

## Upgrade triggers

Consider a shared app-server or daemon only when Candy needs:

- real-time observation from another client;
- live client handoff;
- execution after clients close;
- additional client connections;
- remote control.

Until then, keep TUI execution in-process and Desktop execution in its app-managed child process.

## Decision records and handoff

- [Accepted V1 architecture](../architecture/candy-v1.md)
- [Conditionally accepted technical plan](../architecture/technical-plan-v1.md)
- [Coding implementation plan](../architecture/implementation-plan-v1.md)
- [Pi/provider Compatibility Gate 0](../research/compatibility-gate-0.md)
- [Pi-compatible toolchain baseline](../research/pi-toolchain-baseline.md)
- [Platform Compatibility Gate 0](../research/platform-gate-0.md)
- [Bounded parallel tasks](../adr/0001-bounded-parallel-tasks.md)
- [Superseded DeepSeek-primary decision](../adr/0002-deepseek-primary-minimax-vision.md)
- [DeepSeek-first model portfolio with MiniMax M3](../adr/0003-deepseek-first-multimodal-model-portfolio.md)
- [Codex-style local control baseline](../adr/0004-codex-style-local-control-baseline.md)
- [Narrow native Sandbox Runner](../adr/0005-allow-narrow-native-sandbox-runner.md)
- [Explicit Browser takeover fallback](../adr/0006-use-explicit-browser-takeover-fallback.md)
- [Current macOS Tahoe primary host and `26.5.2` regression baseline](../adr/0009-current-macos-primary-with-regression-baseline.md)
- [V1 product acceptance standard](./acceptance-v1.md)
- [Live provider credential procedure](../testing/live-provider-credentials.md)
- [Current grilling handoff](./grilling-handoff.md)
