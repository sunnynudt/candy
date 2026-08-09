# Candy V1

## Product statement

Candy is a DeepSeek-first single-agent coding product for macOS and Windows 11.

It provides:

- a terminal UI for direct coding interaction;
- an Electron desktop client for session management, permissions, tool visibility, changed files, and diff review;
- a shared TypeScript runtime implemented through a Pi SDK adapter.

Candy V1 validates a useful product slice. It does not attempt complete feature parity with mature coding agents.

## V1 boundaries

Candy V1 is:

- local-first;
- single-user;
- single-agent;
- single-active-session;
- TypeScript-only;
- BYOK for DeepSeek;
- supported on macOS and Windows 11.

Candy V1 does not include:

- a Candy cloud backend;
- Candy accounts, subscriptions, or model billing;
- credential synchronization;
- a system-wide daemon;
- multi-agent orchestration;
- parallel or background tasks;
- remote execution;
- a plugin marketplace;
- real-time control from multiple clients.

## Runtime topology

### TUI

```text
Candy TUI
  -> @candy/runtime
  -> Pi SDK adapter
  -> DeepSeek
```

The TUI runs the runtime in-process. It may reuse `pi-tui` rendering components, but it does not run Pi interactive mode.

### Desktop

```text
Electron Renderer
  -> Electron IPC
  -> Electron Main
  -> typed JSONL over stdio
  -> Candy app-server child process
  -> @candy/runtime
  -> Pi SDK adapter
  -> DeepSeek
```

The app-server is owned by the Desktop application. It must not outlive the application and is not a cloud server or system-wide daemon.

## Shared runtime

TUI and Desktop use the same `@candy/runtime` package.

The runtime owns:

- Pi SDK integration;
- DeepSeek provider configuration;
- tool execution policy;
- permission requests;
- session loading and saving;
- normalized runtime events.

Clients own presentation and user interaction.

## Sessions

V1 reuses Pi session machinery and format in a Candy-owned application-data directory resolved by a platform adapter.

Candy must not write into Pi's default session directory.

TUI and Desktop may view and sequentially resume each other's sessions. They may not simultaneously control an active turn.

## Execution ownership

V1 permits only one active execution.

The execution lock contains:

```json
{
  "sessionId": "...",
  "ownerPid": 1234,
  "ownerType": "tui",
  "acquiredAt": "..."
}
```

A client without the lock may inspect saved sessions but cannot start or continue execution.

Normal exit releases the lock. Crash recovery must detect stale locks safely on macOS and Windows 11.

Cross-client continuation means:

1. stop or finish the current turn;
2. wait for active tools to stop;
3. persist completed messages and results;
4. release the execution lock;
5. start a new turn from another client.

V1 does not migrate an in-flight tool call between processes.

## Pi integration

Candy depends on Pi through a narrow adapter.

V1 does not:

- fork Pi;
- expose Pi internal types to clients;
- run Pi interactive mode;
- rewrite the agent loop;
- promise compatibility with the full Pi extension ecosystem.

Pin the Pi dependency version and verify session behavior on both supported operating systems.

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

## V1 product value

Candy V1 focuses on:

- TUI and Desktop access to the same persistent sessions;
- DeepSeek-first setup;
- desktop session management;
- structured tool visibility;
- permission approval;
- changed-file presentation;
- diff review;
- cross-client sequential continuation.

Tool count is not a V1 differentiator.

## Credentials

Users provide their own DeepSeek credentials.

Allowed credential sources:

- a temporary `DEEPSEEK_API_KEY` process environment;
- the local operating-system credential store.

Credential resolution order:

1. temporary process environment;
2. local credential store;
3. `needs_credentials`.

Provider credentials must be removed from environments passed to tools and child processes.

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

The only permitted network use of a DeepSeek credential is authentication to the approved DeepSeek HTTPS API endpoint.

Candy V1 has no remote telemetry or automatic crash upload.

## First vertical slice

Implement and verify only:

1. initialize the TypeScript workspace;
2. pin Node, package-manager, and Pi SDK versions;
3. run one DeepSeek prompt through the Pi SDK;
4. stream the response;
5. execute one read-only tool call;
6. persist the session in Candy's application-data directory;
7. load the same session on macOS and Windows 11;
8. verify the credential does not enter logs, sessions, tool subprocesses, or the repository.

Do not start the full TUI or Electron UI before this slice passes.

## Upgrade triggers

Consider a shared app-server or daemon only when Candy needs:

- real-time observation from another client;
- live client handoff;
- execution after clients close;
- parallel background tasks;
- additional client connections;
- remote control.

Until then, keep TUI execution in-process and Desktop execution in its app-managed child process.
