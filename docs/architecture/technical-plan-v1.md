# Candy V1 Technical Plan

Status: accepted implementation direction; product coding authorized, capability enablement and release claims remain Gate-controlled

This document selects the implementation shape for the accepted Candy V1 architecture. Product coding is authorized, but this does not authorize product scope changes or weaken any Gate. External API and platform facts are recorded under `docs/research/`; an unresolved compatibility Gate blocks enabling or claiming the affected capability, while independent implementation may continue behind an explicit unavailable capability and deterministic test adapters.

Evidence reviewed on 2026-08-09:

- [Pi, provider, and toolchain Compatibility Gate 0](../research/compatibility-gate-0.md)
- [Pi-compatible toolchain baseline](../research/pi-toolchain-baseline.md)
- [macOS, Windows, Electron, Browser, credential, process, and data Platform Gate 0](../research/platform-gate-0.md)

## Decision summary

- Use a TypeScript workspace with a small number of packages at real process or dependency seams; one audited Rust native helper is the only exception and contains no product or control-plane behavior.
- Make Pi `0.84.1` the agent-runtime compatibility anchor. Pin Node.js `22.23.2`, its bundled npm `10.9.8`, TypeScript `5.9.3`, the complete Pi package family at `0.84.1`, and Electron `43.2.0`; do not upgrade these boundary-sensitive versions independently.
- Keep the Candy Runtime as the single deep Module used by TUI and Desktop.
- Put Pi behind one injected Agent Engine Interface. Only the Pi Adapter package may import Pi packages.
- Keep Provider, Tool Host, Task Engine, Task Store, Workspace, scheduler, and long-running policy as internal Runtime or Pi Adapter Modules until a second real caller requires another package.
- Use versioned, runtime-validated JSONL over stdio between Electron main and the app-server child.
- Use `node:sqlite` conditionally for transactional task metadata and fenced cross-process leases; keep Pi sessions in Candy-owned session storage and attachments as separate blobs.
- Use Electron `WebContentsView`, a persistent Electron `Session`, `DownloadItem`, and `webContents.debugger` for Browser Workspace. Candy does not implement a browser engine or run Playwright, agent-browser, or browser-use in its production control path.
- Use `@napi-rs/keyring@1.3.0` behind the Platform credential Interface; do not use archived `keytar` or an encrypted file as a credential-store substitute.
- Treat approvals and command sandboxing as separate controls. Mutable shell tools remain disabled until the platform sandbox gate passes on both supported operating systems.
- Test every external seam through the same Interface used by production callers.

## Workspace and package topology

### Version baseline

| Layer | Gate baseline | Status |
| --- | --- | --- |
| Agent runtime Node.js | `22.23.2` for TUI and packaged Desktop app-server | Pi-tested Node 22 line; installation/package smoke pending |
| Package manager | bundled `npm@10.9.8` with one root lockfile v3 and `npm ci` | matches the selected Node and Pi's normal CI path |
| TypeScript | exact `5.9.3`, ESM/NodeNext, compiled JavaScript in production | matches Pi `v0.84.1` |
| Pi | complete `@earendil-works/pi-*` closure at exact `0.84.1`; public root SDK export only | selected; install-tree and live adapter smoke pending |
| Electron | `43.2.0`, embedding Node `24.18.0` | selected Gate baseline for macOS `26.5.2` Apple Silicon and Windows 11 |
| Task metadata | Node `node:sqlite`, SQLite in local Candy app-data | conditional on G1 topology/package tests |
| Credential store | `@napi-rs/keyring@1.3.0` | conditional on signed package tests |

The Desktop app-server runs under a separately packaged Node `22.23.2` runtime. Electron's embedded Node `24.18.0` remains confined to Desktop main/preload responsibilities and never loads the Pi Adapter. This keeps TUI and Desktop agent execution on the same Pi-tested Node line. G1 must prove that the app-server and Electron main can safely coordinate through the typed protocol and selected persistence topology; shared database access is not assumed.

### Compatibility-train policy

Pi, the agent-runtime Node major, npm major, TypeScript minor/major, and any Pi transitive override form one compatibility train. A change to any member requires a new exact lockfile and the complete Pi Adapter matrix on both supported platforms. Security patches inside the accepted Node 22 line may move independently only after the same automated matrix passes. Candy does not override Pi transitives merely to obtain newer packages, and it does not introduce another package manager in V1.

Direct Candy dependencies remain exact and the root lockfile pins transitives. Installation must assert that every resolved `@earendil-works/pi-*` package is `0.84.1`; directly pinning only `pi-coding-agent` is insufficient because its sibling dependencies use caret ranges.

The intended source layout is:

```text
apps/
  tui/                 terminal composition root and presentation
  app-server/          Desktop child-process composition root
  desktop/             Electron main, preload, renderer, Browser implementation
packages/
  protocol/            versioned wire schemas and presentation-safe projections
  runtime/             CandyRuntime and its internal task control plane
  pi-adapter/          the only package allowed to import Pi packages
  platform/            macOS, Windows, and in-memory platform adapters
native/
  sandbox-runner/      audited Rust OS containment and process-tree helper
```

This is not a package-per-diagram design. In particular, scheduler, Task Engine, Provider, Tool Host, Task Store, Workspace, validators, and permission policy begin as internal Modules. The deletion test justifies the four TypeScript packages above:

- deleting `protocol` would duplicate and drift the cross-process contract;
- deleting `runtime` would spread task state and policy across both clients;
- deleting `pi-adapter` would leak Pi types and upgrade risk into Candy;
- deleting `platform` would spread operating-system assumptions across the runtime and clients.

The native helper is not a fifth product Module. It is a replaceable Platform Adapter implementation forced by OS-only capabilities. Deleting it removes strong Shell containment and reliable Windows descendant-process ownership; no task, model, approval, provider, workspace-policy, session, Browser, or UI behavior may move into it.

No generic `common`, `utils`, plugin, or workflow package is planned for V1.

## Dependency direction

Dependencies point inward toward Candy-owned contracts:

```text
tui ---------------------> runtime <----- pi-adapter
  \                          ^                ^
   +-----> protocol          |                |
                             |                +---- Pi packages
app-server -----------------+-----> platform
   |
   +-----> protocol

desktop main/preload/renderer -----> protocol
desktop main ----------------------> platform
desktop main owns Browser implementation
app-server selects the native runner ----> runtime/v1 ---- versioned JSONL stdio ----> native sandbox-runner
```

Composition roots create concrete Pi, Browser, and credential adapters. `runtime` does not import Electron, Pi, or a provider SDK. In the current source, `runtime/src/v1.ts` does contain the TypeScript clients for the native macOS and Windows runner protocols, and the app-server selects the relevant client; this is a narrow process-control exception, not a second Runtime implementation. `protocol` contains no I/O or business policy.

## External and internal seams

### Runtime Interface

The accepted `dispatch`, `events`, and `snapshot` Interface remains the only client-facing runtime surface. Command receipts acknowledge acceptance, not completion. Completion and failure arrive as sequenced events. Commands that can mutate task state carry an idempotency identifier and an expected task revision.

Production adapters are:

- direct in-process calls for TUI;
- typed JSONL over stdio for Desktop;
- an in-memory adapter for contract tests.

### Agent Engine Interface

The Runtime depends on one narrow Agent Engine Interface that advances a complete turn, emits model/tool lifecycle observations, requests action authorization, and stops through `AbortSignal`. The Pi Adapter satisfies this Interface. A deterministic fake drives Runtime tests.

Pi messages, tool definitions, model objects, session paths, and provider payloads never cross this seam. A Pi upgrade is complete only when adapter contract, session reload, cancellation, tool-policy, and event-order tests pass.

### Browser Interface

The existing `open`, `observe`, `act`, `setControl`, and `close` Interface remains task-oriented. Desktop supplies the Electron adapter; TUI supplies an explicit unavailable-capability adapter; tests use a deterministic in-memory page adapter.

Every action names a tab and the revision of the observation it was planned from. A changed revision produces a stale-observation result, never a best-effort click. User input changes the tab's control owner to the user and aborts the conflicting action.

### Platform Interface

`@candy/platform` currently supplies Candy-owned application-data paths, OS credential-store access, SQLite task persistence and leases, and child-environment hygiene. It provides the shared semantics for those capabilities while the active OS binding supplies the platform detail.

It is not yet the sole facade for every platform concern. `runtime/src/v1.ts` currently contains the macOS Sandbox Runner client, Windows Job Object Runner client, and POSIX-only process supervisor; `apps/app-server` branches to select the native validator and runner filename; Electron main has narrow packaging and capture branches. These branches are limited to native/process or packaging mechanics, but the source does not satisfy a stricter rule that every `process.platform` branch lives in `@candy/platform`.

### Current cross-platform source alignment

This snapshot describes the checked-in implementation as of 2026-08-12, not an acceptance or release claim.

| Capability | Shared implementation | OS-specific adaptation | Current boundary/status |
| --- | --- | --- | --- |
| App data, sessions, attachments, state, Browser profile, and worktrees | `resolveAppPaths` and the same Candy-owned SQLite/session layout | macOS uses `~/Library/Application Support/Candy`; Windows uses `%LOCALAPPDATA%`/`%APPDATA%` and `path.win32` | Implemented in `@candy/platform`; TUI, Desktop, and app-server resolve the same root. |
| Credentials and child environments | `CredentialStore`, secret leases, provider resolution, and child-environment cleaning | `@napi-rs/keyring` binds to Keychain or Credential Manager | Renderer sees presence only; no separate provider implementation per OS. |
| Task/runtime, Pi, providers, protocol, scheduling, persistence schema, and approval policy | Shared TypeScript packages (`runtime`, `pi-adapter`, `protocol`, and `platform`) | None in the normal model/task control path | OS differences must not change task, provider, approval, or session semantics. |
| Workspace paths and Git worktrees | Shared worktree/Apply logic with an injectable `PathSeam` | Native Node path operations on the host; `path.win32` is injected by Windows-path tests; macOS canonical-path handling covers `/var` aliases | This is a shared algorithm with explicit path semantics, not duplicate worktree code. |
| Native command containment and process-tree lifetime | One versioned JSONL contract and one Rust crate | macOS uses a default-deny Seatbelt profile and process-group cancellation; Windows uses `CreateProcessW` plus a Job Object and reparse-point checks | This is intentionally a separate native backend, but its TypeScript clients and selection still live in `runtime`/app-server. G2 remains incomplete: Windows has no proven OS-level no-network containment, and both platforms still need the remaining packaging/security evidence. |
| Desktop runtime packaging and Browser surface | Shared Electron main/preload/protocol and Browser policy | Packaged app-server selects `node.exe` on Windows versus `bin/node` on macOS; macOS has a narrow screenshot-capture branch | These are packaging/UI-host details, not separate product runtimes. |

## Process topology

### TUI

The TUI loads Runtime, Pi Adapter, and `@candy/platform` services in one Node process. It never starts Pi interactive mode. Its current interactive task path passes the `read-only` approval profile and does not configure the native Sandbox Runner; Browser capability is unavailable. A TUI process may execute tasks only after acquiring the same persisted global slot and per-task ownership leases used by Desktop.

### Desktop

Electron main owns windows, preload bridges, Browser Workspace, credential writes, downloads, tray lifecycle, and the app-server child. The app-server owns scheduling and Runtime instances. The renderer receives presentation-safe state and can invoke only allowlisted preload operations.

The app-server is started with dedicated stdin/stdout pipes. Protocol traffic uses stdout only; human diagnostics use a redacted stderr channel. EOF from the parent begins cancellation and shutdown. An app-server crash marks uncertain active work interrupted; restart may restore inspection state but never silently resumes a turn or replays a tool call.

## Protocol and event rules

- UTF-8, one JSON object per line, protocol version `v: 1`.
- Runtime validation occurs before dispatch on both ends.
- Every command has an identifier; every task event has a monotonic task sequence and resulting task revision.
- Requests are never inferred from reconnects. A reconnect obtains `snapshot` plus events after a cursor.
- Unknown message types, oversized lines, invalid payloads, and unsupported protocol versions fail closed.
- Credentials and binary attachment content are forbidden fields. Attachments and screenshots travel by Candy-owned identifiers.
- Renderer projections omit raw command environments, provider payloads, cookies, authentication headers, saved passwords, and complete secrets.

## Task persistence and execution leases

Candy stores three different kinds of data deliberately:

1. transactional Candy metadata: task state, queue order, revisions, ownership leases, model selection, workspace association, and interruption markers;
2. Pi-backed session data in a Candy-selected per-task location;
3. immutable or replaceable blobs for attachments and browser screenshots.

The conditionally selected metadata implementation is Node 22 `node:sqlite` in local Candy app-data, configured with extension loading disabled, an explicit bounded busy timeout, WAL, durability-oriented synchronization, prepared statements, and no untrusted SQL. Node 22 does not expose the Node 24 `defensive` option, so Candy does not claim that control. It stores only Candy task metadata, queue order, schema versions, and fenced leases; Pi session bodies and attachments remain outside it. G1 must prove import, concurrency, WAL recovery, migration, and packaging in TUI and packaged app-server topologies before adoption becomes final; Electron main accesses state only through the protocol.

A task ownership lease contains an unguessable owner nonce, PID, process-start identity, heartbeat, and monotonically increasing fencing generation. Recovery requires an expired heartbeat, owner-liveness evaluation, and an atomic generation change; recovery marks the task interrupted and never repeats an uncertain action.

Persisted queued, paused, and interrupted tasks do not execute after restart until an explicit resume command wins a lease. Absolute workspace paths are task-local metadata, not session content. Cross-platform session compatibility means that a copied session can be loaded after the user remaps its workspace on the other operating system; it does not promise that a Windows absolute path works on macOS.

## Pi and provider integration

The Pi Adapter owns:

- construction of the Pi agent/session objects through verified public exports;
- translation between Candy and Pi turn, message, event, and tool contracts;
- Provider adapters constructed from a code-owned model catalog;
- wrapping Pi's basic file and shell tools behind Candy authorization, serialization, cancellation, environment sanitation, and change tracking;
- compatibility assertions for the pinned Pi version.
- install-tree assertions for one exact, unmixed Pi package family.

The model catalog separates Candy display labels from official provider model identifiers. The verified static contracts are:

| Candy label | Pi provider | Official model ID | Approved API path |
| --- | --- | --- | --- |
| DeepSeek V4 Flash | `deepseek` | `deepseek-v4-flash` | `https://api.deepseek.com/chat/completions` |
| DeepSeek V4 Pro | `deepseek` | `deepseek-v4-pro` | `https://api.deepseek.com/chat/completions` |
| MiniMax M3 | `minimax-cn` | `MiniMax-M3` | `https://api.minimaxi.com/anthropic/v1/messages` |

DeepSeek uses the OpenAI-compatible Chat Completions contract for both V1 models; Candy does not use the legacy `deepseek-chat` or `deepseek-reasoner` aliases, the `/beta` strict-tool path, or the Responses API in the first slice. MiniMax uses the domestic Anthropic-compatible path because that is the verified Pi 0.84.1 provider route. Text and image are compatible with Pi's public types; video remains unavailable because Pi 0.84.1 has no public video content type.

A label is enabled only after its authentication, streaming, tool calling, reasoning/thinking replay, attachment behavior, cancellation, error behavior, and the user's entitlement pass a live contract test. There are no guessed identifiers and no silent fallback. The supplied Token Plan Plus screenshot is not sufficient evidence of current account entitlement; the current subscription Key and control panel must pass the recorded MiniMax live matrix without storing the Key.

Provider concurrency and rate limiting are internal to the Pi Adapter/Provider implementation. DeepSeek and MiniMax have independent gates. Provider HTTP is privileged application traffic; it does not grant network access to model-generated commands.

## Credential path

The renderer can set, replace, delete, and query presence through a dedicated preload Interface. It cannot read a complete credential. This bridge is physically separate from Runtime JSONL and excluded from generic IPC logging. Production storage uses the exact `@napi-rs/keyring@1.3.0` adapter to macOS Keychain and Windows Credential Manager, subject to signed-package architecture tests. Failure is explicit; there is no fallback to `keytar`, `safeStorage` plus a file, a credential CLI, `.env`, or repository storage.

Runtime provider code obtains a short-lived secret lease from the Platform credential adapter or approved temporary process environment. The secret is used only to build authentication for the allowlisted provider host and is then released. Tool subprocess environments are constructed from an allowlist rather than copied from `process.env`; all active provider variables and known secret values are removed before spawn.

A canary-secret test must prove that the secret does not appear in Runtime events, sessions, metadata, attachments, logs, diagnostics, crash data, browser observations, tool arguments, or tool subprocess environments. Candy-managed write/commit/push operations scan for every active provider credential and fail closed on a match.

## Tool execution, approvals, and sandbox

The Tool Host classifies every call before execution:

- side-effect-free workspace read/search;
- workspace mutation;
- shell command;
- Git mutation or external side effect;
- Browser action;
- unsupported or malformed action.

Classification selects the sandbox capability and approval requirement. Reads may share a task-local concurrency pool. File mutations, shell commands, Git mutations, and conflicting Browser actions use a task-local serial lane. Separate Task Worktrees may use independent lanes.

Approval never substitutes for sandboxing. Conversely, a sandbox allowance does not remove a required approval. The accepted implementation direction is a per-command Rust Sandbox Runner with separate macOS and Windows native backends. TypeScript supplies an executable, argument array, working directory, environment allowlist, capability policy, cancellation token, and request identifier through a versioned JSONL stdio protocol; the helper returns lifecycle and containment results, never task or model decisions.

Until both native backends pass escape, network, cancellation, descendant-process inheritance, packaging, and security-review tests, V1 may expose the read-only Runtime proof but must not claim the default Auto profile or enable unrestricted mutable shell execution. On Windows the same helper owns a Job Object so cancellation and application exit close the complete process tree.

## Workspace and change transfer

The Workspace Module uses Git through argument arrays with an explicit working directory; it never builds shell command strings. A writable concurrent Git task receives a detached Task Worktree associated with a fixed base commit. Candy records the task base, workspace identity, and change manifest.

Apply Changes is a reviewed transfer, not a merge or commit. The implementation produces a binary-safe patch plus an explicit untracked-file manifest without modifying the user's index. It applies only after checking target identity, target dirtiness, base compatibility, path containment, and credential scans. A conflict or changed target stops before partial transfer where possible and presents recovery instructions.

Non-Git workspaces have one writer lease and a before/after change manifest. They do not offer worktrees or automatic Git initialization.

## Browser Workspace implementation

Desktop uses Electron `WebContentsView` and its embedded Chromium rather than implementing or bundling a second browser engine. A `persist:` Electron Session provides the Candy-owned profile, `DownloadItem` provides visible download lifecycle, and `webContents.debugger` carries an allowlisted CDP subset against the same visible WebContents. Playwright remains an external packaged-app test tool, not a production Browser dependency.

The Adapter must provide structured observation, screenshot capture, navigation, input, download visibility, user takeover, and cancellation through that same WebContents instance. Electron does not expose a documented physical-versus-synthetic source flag for all input events. G3 therefore first tests automatic takeover in the packaged app. If it cannot distinguish the source reliably, the accepted fallback is a visible Take Control action that cancels the conflicting agent action and transfers the Browser Control Owner to the user.

The Browser Module never exposes raw CDP, cookies, storage tokens, authentication headers, or arbitrary JavaScript execution to the model. CDP is an implementation detail used by a small allowlisted command set. Page text and accessibility data are untrusted model input. Site permission and sensitive-action confirmation are evaluated after each navigation and before each action.

External automation packages are adopted only if they can control the existing embedded WebContents and profile without introducing a second browser lifecycle or their own agent loop. `agent-browser` and `browser-use` are not architectural dependencies merely because they offer browser automation.

## Long-running tasks and Auto Debug

Long-running behavior is a completion policy inside Task Engine. The validator Interface runs one explicit command/build/test or Browser assertion and returns structured evidence, duration, and a stable result fingerprint. Command and Browser validator adapters plus an in-memory test adapter justify the seam.

Auto Debug alternates a normal Pi-controlled turn with the same validator. It completes only on validator success. It pauses on approval, user request, ownership loss, budget exhaustion, repeated unchanged evidence without a meaningful workspace delta, or an unrecoverable tool/provider error. Resume is explicit and uses the persisted evidence; uncertain side effects are never replayed.

## Testing strategy

Tests cross Module Interfaces rather than internal implementation details:

- protocol: schema fixtures, version rejection, line limits, and secret-field rejection;
- runtime: deterministic Agent Engine, Browser, Provider, clock, and Platform adapters;
- Pi Adapter: pinned-version contract, event order, cancellation, tool authorization, and session reload;
- providers: recorded parser fixtures plus opt-in live domestic-endpoint contract tests with redaction assertions;
- platform: macOS `26.5.2` Apple Silicon and Windows 11 credential, lease, process-tree cancellation, path, and app-data tests;
- workspace: Git fixture repositories covering dirty targets, binary files, untracked files, conflicts, and worktree cleanup;
- Desktop: preload allowlist, renderer isolation, app-server restart, Browser local-site fixture, download, takeover, and screenshot tests;
- security: canary secrets, path escape, command network denial, browser credential non-observability, and malformed protocol fuzz cases;
- end to end: the same saved task fixture loads on macOS `26.5.2` Apple Silicon and Windows 11 after workspace remapping.

Live provider tests are never required on untrusted pull requests and never print request authentication. Cross-platform support is claimed per slice only after both operating systems pass its required matrix.

## Compatibility gates

- **G0 Model and Pi contract — conditional**: exact public Pi exports and static provider contracts are verified; npm installation, real DeepSeek/MiniMax credentials, Token Plan entitlement, streaming/tool/thinking replay, cancellation, and two-OS smoke tests remain open.
- **G1 Persistence — conditional**: Node 22 `node:sqlite` is selected, but TUI/app-server import, concurrent fencing, WAL recovery, migration, protocol-only Electron access, and packaged macOS `26.5.2`/Windows 11 tests remain open.
- **G2 Local control — implementation direction accepted, verification blocked**: the Rust Sandbox Runner exception and Windows Job Object ownership are accepted. Exact native backends, escape/no-network enforcement, process inheritance, cancellation, packaging, and security review remain open. Approval plus a Workspace Guard is not a strong sandbox.
- **G3 Browser — fallback accepted, verification conditional**: `WebContentsView` plus Electron Session/debugger is selected. Automatic takeover is preferred; explicit Take Control is the accepted fallback. Debugger detach, profile isolation, action cancellation, and browser-credential non-observability remain to be proved.
- **G4 Workspace transfer**: worktree creation and reviewed, binary-safe, index-safe Apply Changes pass conflict and recovery fixtures on both operating systems.
- **G5 Long-running safety**: validators, budgets, stall detection, pause/resume, explicit quit, and crash interruption pass deterministic tests.

An unresolved gate is reported as a blocker in the implementation plan. It is not converted into a hidden fallback.

## Accepted Gate 0 implementation decisions

- Candy V1 targets macOS `26.5.2` on Apple Silicon; Electron 43 remains the Gate baseline without a broader macOS compatibility promise.
- Product and control-plane code remains TypeScript; one audited Rust Sandbox Runner is allowed for native containment and process-tree ownership.
- Automatic Browser takeover remains preferred, with a visible Take Control action as the accepted deterministic fallback.
