# Candy V1

## Product statement

Candy V1 is a standalone, DeepSeek-first coding product delivered as a terminal UI (TUI). It provides a Codex-class local coding loop without requiring Codex, OpenCode, or a separately installed Pi CLI. The TUI runs one agent per task and may run independent tasks concurrently within a bounded limit.

V1 targets the current macOS Tahoe `26.x` Apple Silicon host (currently `26.6.1`) and Windows 11.

The Electron Desktop client and Browser Workspace are explicitly V2 scope. Their source, adapters, and historical design notes must not be used as evidence that V1 is implemented or accepted.

## V1 boundaries

Candy V1 is:

- TUI-only and local-first;
- single-user and single-agent per task;
- bounded to three concurrent tasks by default and five at most;
- TypeScript for product and control-plane code, with only the narrow Rust native-helper exception for OS command sandboxing and Windows process-tree ownership;
- BYOK for DeepSeek and MiniMax domestic Token Plan credentials;
- persistent in Candy-owned application data;
- usable from a stable local `candy` command on macOS and Windows.

Candy V1 includes the following user journey:

1. configure or inspect provider credential presence without exposing the credential;
2. select a workspace and create a task;
3. stream a Pi-backed model turn through Candy's narrow adapter;
4. inspect bounded, redacted tool activity and task state;
5. steer, follow up, or cancel an active task when the state permits it; while the current TUI-owned task runs, ordinary input is queued by default as a bounded, redacted follow-up for the next turn, and `/steer <text>` remains the explicit injection path into the active turn;
6. review changes and explicitly apply or discard them where the selected workspace mode supports it;
7. restart Candy, inspect persisted evidence, and continue only with a new explicit prompt.

The TUI starts in the **safe workspace** access mode: file read/create/edit/delete are enabled inside an isolated Candy-owned Task Worktree under the workspace's `.git/candy-worktrees/` directory (falling back to the Candy application-data directory when `.git` is a file, such as in submodules), and local file mutations do not pause a running task for per-operation confirmation. The resulting Git status, diff, and validation evidence remain available for task-level review. `/access` is the user-facing control: `review` is read-only, `safe` is the default isolated workflow, and `current` explicitly works in the current workspace, including existing uncommitted changes. On an approved host, both writable access modes receive offline local-command capability by default: they use only the selected workspace's already-installed `node_modules`, and Candy grants the pinned Node runtime read access needed for `npm run` scripts. Candy never installs dependencies automatically; missing local dependencies remain a task-visible condition. Network development commands in both writable modes require one-command approval and may install dependencies or fetch source, but never publish or carry credentials.

Candy provides the same Personal Preview `/access full` contract on macOS Tahoe arm64 and Windows 11 x64 once the host's Full Access Backend is available. The Safe status chrome has a clickable `⚠ 开启 Full access` entry that reveals the same warning, then changes to a separate clickable `⚠ 确认开启 Full access` acknowledgement. The two clicks match `/access full` then `/access full confirm`; Full Access becomes the local default for future Auto tasks, including after a TUI restart. `/access safe` is the documented exit, and `/access current` combines direct Local Workspace placement with Full Access for the Codex-style development flow. Each task persists its own `full_access` decision, independent of later preference changes, and the status chrome continuously displays an amber `⚠ FULL ACCESS` badge. Full Access grants broad local filesystem, command, and network capability without per-command approval, while retaining cleared child environments, bounded/redacted output, owned process-tree cancellation, credential isolation, credential-scanned commits, explicit push authorization, and publication controls. The platform backend differs—macOS uses a Keychain-denying Seatbelt profile; Windows uses an AppContainer or Win32 App Isolation backend with stable Candy identity—but the user contract does not. A host without a verified backend reports Full Access unavailable rather than silently using an unrestricted fallback. [ADR-0014](../adr/0014-cross-platform-full-access-contract.md) is authoritative.

Credentials, Git publication, and arbitrary external roots remain blocked outside an explicit Full Access task. Shell and other side-effectful capabilities remain unavailable unless their platform-specific security and approval gates pass; a disabled or unverified capability is not V1 acceptance evidence.

Candy V1 does not include:

- an Electron Desktop client or app-server product surface;
- a Browser Workspace, browser profile, browser automation, or browser screenshots;
- a Candy cloud backend, account, subscription, telemetry service, or model billing;
- a system-wide daemon or execution after Candy quits;
- remote execution, multi-agent orchestration, a plugin marketplace, or a general workflow engine;
- real-time control from multiple clients or cross-client handoff;
- a V1 Auto Debug or Desktop tray workflow.

These deferred capabilities may be designed or retained in the repository for V2, but they are not required V1 deliverables and cannot block the TUI V1 acceptance decision.

## Runtime topology

```text
Candy TUI
  -> @candy/runtime
  -> Pi SDK adapter
  -> selected provider
```

The TUI runs the runtime in-process. Candy owns command parsing, task state, scheduling, session ownership, approval decisions, workspace policy, and the user-facing transcript. Pi is used through a narrow adapter; Candy does not run Pi interactive mode or import Pi's client, protocol, plugin, or default session-store surfaces. Built-in TUI commands use the slash-prefixed form (`/model`, `/new`, `/attach`, and so on) as the canonical syntax; the earlier colon-prefixed form remains a compatibility alias. This aligns the command entry convention with common coding-agent CLIs without promising full command parity.

TUI and Desktop do not share a V1 client contract. A future Desktop client may use an app-server child process, but that is a V2 architecture and is not part of the V1 runtime topology.

## Tasks, sessions, and continuation

Each Candy Task has one execution owner and one persistent session. Candy reuses Pi session machinery and format in a Candy-owned application-data directory resolved by a platform adapter. Candy must not write into Pi's default session directory.

The TUI persists completed messages, bounded tool evidence, task state, revision, and change-review metadata. An interrupted or uncertain turn is never silently replayed. Restart recovery displays persisted evidence and requires an explicit continuation prompt. In-flight tool calls are not migrated or replayed.

Independent tasks may execute concurrently within the configured global limit. File mutations and shell commands are sequential within a task by default. A task that loses ownership becomes resumable only through the explicit recovery rules; stale owners must not mutate current task state.

## Workspace and changes

Candy supports a selected Local Workspace and, where the task policy requires isolation, a Candy-owned Task Worktree. Concurrent writable tasks for the same Git repository use separate worktrees. Candy does not silently commit, push, merge, release, deploy, or initialize Git. Model-issued Git commits run only through the dedicated `candy_git_commit` tool in writable tasks, giving Codex-style granular checkpoints with a bounded, credential-scanned message; pushing requires the user's explicit per-task authorization (`/push allow` at task start) and is never silent.

Change review is explicit. The TUI exposes bounded changed-file and diff evidence; applying changes requires the contracted review and ownership checks. Discard removes only Candy-owned worktree state. Dirty targets, conflicts, path mismatches, symlink or reparse-point risks, and credential matches fail closed.

## Pi integration

Candy depends on Pi through a narrow adapter. V1 does not fork Pi, expose Pi internal types to clients, run Pi interactive mode, rewrite the agent loop, or promise compatibility with the full Pi extension ecosystem.

The adapter projects settled, retry, compaction, cancellation, assistant, and tool observations into Candy's bounded event model. Provider error text, credentials, tool arguments, and unbounded tool output are not copied into the TUI transcript. The adapter uses Candy-owned resource loading only; Pi's default `.pi` resources, extensions, packages, skills, prompts, themes, and executable resources are outside the Candy session boundary.

The complete Pi package family is pinned to exact `0.84.1`. Node remains `22.23.2`, npm remains `10.9.8`, and TypeScript remains `5.9.3`; these compatibility-sensitive versions upgrade together.

## Tools, approvals, and cancellation

V1 reuses Pi's basic file and model tools behind a thin Candy Tool Host. The host provides permission checks, secret isolation, normalized bounded events, cancellation, file-change tracking, and structured errors.

Tool names are bounded and redacted. Tool arguments, output, provider errors, and credentials are not exposed merely to make a status line informative. Side-effect-free reads and searches may execute in parallel within one task; file mutations and shell commands execute sequentially by default.

The default profile permits only the contracted workspace operations. Read-only rejects mutations. In Auto, containment-checked local file mutations, including deletion, execute without pausing the task for per-operation approval and are exposed through task-level change review. Writable Git tasks additionally expose the `candy_git_commit` tool: it stages the workspace, scans the exact staged content for active provider credentials (failing closed), and creates one bounded commit; the `push` option is honored only when the user authorized it for the task (`/push allow`), and pushes the current branch to its `origin` upstream. Sensitive external actions require explicit approval. Native command containment, process-tree ownership, and network policy are platform adapters; a platform without completed G2 evidence remains fail-closed.

## Candy-owned instructions and resources

## Candy-owned instructions and resources

Candy may load global instructions, prompt templates, and declarative Markdown skills from its Candy-owned application-data resource root (highest priority) and from external skill roots: the agent-agnostic shared directory `~/.agents/skills` by default, plus directories listed in `CANDY_SKILL_DIRS` (path-delimiter separated, `~` expanded) when the user configures them. Resource files are bounded, non-symlinked, validated, and redacted before entering Pi context; the model-visible skill list is capped at 80 skills with higher-priority roots winning, and duplicate names report a collision diagnostic. Workspace `AGENTS.md` is handled through the same restricted adapter boundary. External tool configuration, Pi default resources, and unrelated repositories are never Candy runtime credential or execution sources.

Loaded skill directories become read-only roots for Candy's file tools: `candy_read` and `candy_list` accept absolute paths inside them (bounded, symlink-free, secret-redacted); writes, deletes, and searches never enter them. Skill scripts are plain files executed only through the task's local-command capability with the usual command policy; Candy never auto-executes skill content. Candy does not read or execute Pi's own `.pi` resources, extensions, packages, themes, or executable resources.

## Providers and credentials

DeepSeek is the default provider path. MiniMax domestic Token Plan is supported only through its approved domestic endpoint, `https://api.minimaxi.com`; Candy must not fail over to the global MiniMax endpoint. Provider model contracts, live entitlement, multimodal behavior, and cancellation are accepted only with the evidence described by the live-provider procedure.

In addition to the built-in DeepSeek and MiniMax paths, users may configure additional OpenAI-compatible models through the Candy-owned `models.json` in the application-data directory (bounded, validated, credential-free). Each entry declares an id, label, model name, OpenAI-compatible API root `baseUrl`, and a `credentialName`; the client appends `/chat/completions`. Configured models are non-vision and are verified by the user with their own API key (BYOK); they do not constitute V1 live-gate acceptance evidence. The model id, label, and credential name are also surfaced by `/model`, `/credentials`, and `/credential`.

Users may set, replace, query presence, and delete DeepSeek, MiniMax, and configured-provider credentials. Credentials may come only from a temporary provider-specific process environment or the operating system's local credential store. The TUI may report presence but never reads back a complete credential.

Provider credentials must never appear in repositories, sessions, prompts, model-visible context, logs, diagnostics, analytics, crash reports, JSONL messages, tool arguments, browser data, or tool subprocess environments. A Candy-managed write, commit, or push containing an active credential is blocked.

Candy V1 has no remote telemetry or automatic crash upload.

## Acceptance

[Candy V1 Product Acceptance Standard](./acceptance-v1.md) is authoritative for the TUI V1 release decision. It defines separate evidence for the current macOS Tahoe `26.x` Apple Silicon host and Windows 11. Current-host macOS evidence does not prove Windows behavior.

V1 release requires the TUI acceptance gates to pass on both required platforms, all required live provider contracts to be verified for enabled providers, no open P0/P1 defect, and explicit product-owner approval. Desktop and Browser acceptance is deferred to V2.

## V2 boundary

V2 may add the Electron Desktop client, app-server child process, cross-client session inspection and handoff, Browser Workspace, browser profile and control ownership, Desktop packaging/signing, and Desktop/Browser-specific recovery and responsiveness gates. V2 must define its own acceptance contract; V2 work does not retroactively satisfy a V1 TUI gate.

## Source and evidence rules

Use files inside the Candy repository as the source of truth. Do not copy architecture, identifiers, configuration, credentials, or terminology from unrelated repositories. Live provider tests follow [Live Provider Credential Procedure](../testing/live-provider-credentials.md). Existing external tool configuration is discovery evidence only and is never a Candy runtime credential source.

The accepted implementation and security records remain useful design history, but a historical Desktop, Browser, or cross-platform report is not V1 acceptance evidence unless it is explicitly mapped to the TUI contract in `acceptance-v1.md`.
