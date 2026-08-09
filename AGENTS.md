# Candy Repository Guidelines

## Product scope

Candy is a DeepSeek-first, Codex-like single-agent coding product with a terminal UI and an Electron desktop client.

Read `docs/product/candy-v1.md` before changing product scope or runtime architecture.

## V1 constraints

- Use TypeScript.
- Support macOS and Windows 11.
- Integrate Pi through a narrow adapter.
- Do not fork Pi or rewrite its agent loop.
- Run the TUI runtime in-process.
- Run the Desktop runtime in an app-managed app-server child process.
- Keep V1 single-agent and single-active-session.
- Prefer the smallest working vertical slice.
- Do not pursue full feature parity with another coding product.

V1 does not include:

- a Candy cloud backend;
- a system-wide daemon;
- multi-agent orchestration;
- parallel or background tasks;
- remote execution;
- a plugin platform;
- a general workflow engine.

## Security invariants

- DeepSeek credentials must never be committed or written inside a repository.
- Credentials must never enter sessions, prompts, logs, diagnostics, analytics, crash reports, command/event messages, tool arguments, or tool subprocess environments.
- Credentials may only come from a temporary process environment or the operating system's local credential store.
- Credentials may only be transmitted as authentication to the approved DeepSeek HTTPS API endpoint.
- Candy V1 must not upload credentials, sessions, source code, or telemetry to a Candy-operated service.
- The Electron renderer may set, replace, delete, or query the presence of a credential, but must never read back the complete credential.
- Block Candy-managed writes, commits, and pushes when they contain the active credential.

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
- Verify relevant behavior on both macOS and Windows 11 before claiming cross-platform support.

## Development rules

- TUI and Desktop use the same runtime package.
- Store sessions in a Candy-owned application-data directory.
- Reuse Pi session machinery without sharing Pi's default session directory.
- Only one client may execute at a time.
- Other clients may inspect saved sessions but may not control an active turn.
- Reuse Pi tools behind a thin Candy Tool Host.
- Do not add abstractions for hypothetical requirements.
- Preserve unrelated user changes.
- Do not commit, push, publish, or create pull requests unless explicitly requested.

## Agent skills

### Issue tracker

Candy uses this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Candy uses the default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Candy uses a single-context documentation layout. See `docs/agents/domain.md`.
