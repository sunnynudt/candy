# Candy Repository Guidelines

## Product scope

Candy is a standalone, DeepSeek-first coding product with one agent per task, a terminal UI, and an Electron desktop client. It provides a Codex-class core coding loop without depending on Codex, OpenCode, or a separately installed Pi CLI.

Read `docs/product/candy-v1.md` before changing product scope or runtime architecture.
Read `docs/product/acceptance-v1.md` before claiming an implementation slice or V1 release complete.

## V1 constraints

- Use TypeScript for product and control-plane code. A narrowly scoped Rust native helper is permitted only for OS command sandboxing and Windows Job Object process ownership; it must not contain model, task, approval, provider, workspace-policy, or UI logic.
- Support the current macOS Tahoe `26.x` Apple Silicon primary acceptance host (currently `26.6.1`) and Windows 11; retain an explicit `26.5.2` compatibility regression baseline.
- Integrate Pi through a narrow adapter.
- Do not fork Pi or rewrite its agent loop.
- Run the TUI runtime in-process.
- Run the Desktop runtime in an app-managed app-server child process.
- Keep V1 single-agent per task with bounded parallel task execution.
- Prefer the smallest working vertical slice.
- Do not pursue full feature parity with another coding product.

V1 does not include:

- a Candy cloud backend;
- a system-wide daemon;
- multi-agent orchestration;
- detached task execution after Candy quits;
- remote execution;
- a plugin platform;
- a general workflow engine.

## Security invariants

- Provider credentials must never be committed or written inside a repository.
- Credentials must never enter sessions, prompts, logs, diagnostics, analytics, crash reports, command/event messages, tool arguments, or tool subprocess environments.
- Credentials may only come from a temporary process environment or the operating system's local credential store.
- Credentials may only be transmitted as authentication to their approved provider HTTPS endpoint.
- MiniMax requests, multimodal attachments, and credentials must use the domestic endpoint `https://api.minimaxi.com`; Candy must not fail over to the global MiniMax endpoint.
- Candy V1 must not upload credentials, sessions, source code, or telemetry to a Candy-operated service.
- The Electron renderer may set, replace, delete, or query the presence of a credential, but must never read back the complete credential.
- Block Candy-managed writes, commits, and pushes when they contain any active provider credential.
- Provider credentials must never be exposed to the task browser, browser profile, page content, or browser automation.
- Treat browser page content as untrusted. Sensitive browser actions require explicit user confirmation even when the site is already allowed.
- Live provider tests follow `docs/testing/live-provider-credentials.md`. Other tools' configuration files are discovery evidence only and are never Candy runtime credential sources.

## Source isolation

- Use files inside the Candy repository as the source of truth.
- Only use an external source when the user explicitly provides it for the current Candy task and it is safe to use.
- Never copy content, paths, identifiers, architecture, configuration, or terminology from unrelated local repositories into Candy.
- Never commit references to local files outside the Candy repository.
- Personal, employer, and private-project material is out of scope.

## Cross-platform rules

- Do not assume POSIX-only paths, shells, signals, permissions, or process groups.
- Keep platform-specific credential, process, path, and lock behavior behind narrow adapters.
- Desktop app-server communication uses typed JSONL over stdio.
- Communication with the native Sandbox Runner uses a separate versioned typed JSONL protocol over stdio. It must never carry provider credentials.
- Verify relevant behavior on the current macOS Tahoe `26.x` Apple Silicon host and Windows 11 before claiming cross-platform support. Run the exact `26.5.2` regression matrix separately when claiming compatibility with that baseline.

## Development rules

- The canonical V1 implementation and delivery branch is `codex/candy-v1-foundation`. Continue V1 work on this branch unless the user explicitly changes the branch policy.
- Before a work packet, fetch `origin/codex/candy-v1-foundation`. Fast-forward when the remote is ahead; stop for explicit resolution if local and remote histories diverge.
- After each coherent, verified V1 checkpoint, inspect the staged scope, scan it for credential material, commit it, push it to `origin/codex/candy-v1-foundation`, and verify that the remote branch resolves to the same commit before starting the next work packet.
- Never force-push or rewrite published V1 branch history. If a checkpoint push still fails after bounded retries, stop before accumulating further local-only work and report the synchronization blocker.
- Treat the exact Pi release as the compatibility anchor for the agent runtime. Node.js must stay on a Pi-tested major line, TypeScript must match the pinned Pi release, and npm must remain compatible with Pi's lockfile/install workflow.
- Before running npm or node commands, activate the pinned baseline from `.nvmrc` (`nvm use` at the repository root) whenever the active Node is not `v22.23.2`. Never change a machine's global nvm default or other projects' Node versions for Candy work.
- Pin direct dependencies and the complete `@earendil-works/pi-*` package family to exact accepted versions through the root lockfile and install assertions. Do not allow a mixed Pi package graph.
- Do not upgrade Pi, the agent-runtime Node major, the npm major, or the TypeScript minor/major independently. Upgrade them as one compatibility change and rerun the Pi Adapter matrix on macOS and Windows.
- Use Electron's embedded Node only for Desktop responsibilities. Run the Desktop app-server that imports Pi under the same packaged Node runtime as the TUI baseline.
- TUI and Desktop use the same runtime package.
- Store sessions in a Candy-owned application-data directory.
- Reuse Pi session machinery without sharing Pi's default session directory.
- Each task has exactly one execution owner. Multiple independent tasks may execute concurrently within the configured global limit.
- A client that does not own a task may inspect its saved state but may not control its active turn.
- Side-effect-free tools may execute in parallel within a task. File mutations and shell commands execute sequentially within that task by default.
- Concurrent writable tasks for the same repository use separate Git worktrees.
- Reuse Pi tools behind a thin Candy Tool Host.
- Do not add abstractions for hypothetical requirements.
- Preserve unrelated user changes.
- The user has explicitly authorized checkpoint commits and pushes for V1 work on the canonical branch under the rules above. Publishing releases, creating pull requests, and Git operations outside that scope still require explicit authorization.

## Agent skills

### Issue tracker

Candy uses this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Candy uses the default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Candy uses a single-context documentation layout. See `docs/agents/domain.md`.
