# Candy V1 Product Acceptance Standard

Status: accepted TUI-only acceptance contract

This document defines when the Candy V1 TUI is complete. Product scope comes from [Candy V1](candy-v1.md). Electron Desktop and Browser Workspace are V2 and have no required V1 acceptance gates.

## Acceptance policy

- The primary macOS platform is the current stable Tahoe `26.x` Apple Silicon release (currently `26.6.1`). Windows 11 x64 is the second required platform.
- Every deterministic test must pass. A retry does not convert a failure into a pass.
- Every enabled provider's required live contract must pass with real credentials through the same Pi Adapter and provider path used by the TUI.
- A provider or network failure may produce a controlled, actionable result; it must never cause silent fallback, state corruption, uncertain side-effect replay, or secret exposure.
- Any credential exposure, data loss, workspace escape, unauthorized side effect, or task-ownership violation blocks release.
- Disabled Desktop, Browser, Shell, or Auto Debug capabilities are not V1 passes; they are out of scope or explicitly gated.
- Results are recorded against an exact source revision, lockfile, Node/npm/TypeScript/Pi versions, operating system patch, architecture, and fixture revision.

## Result classifications

| Result             | Meaning                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Pass               | All stated outcomes and evidence requirements are satisfied.                                                       |
| Controlled failure | A stated dependency failure is preserved safely and produces the specified actionable state.                       |
| Blocked            | Required credential, entitlement, or target platform is unavailable. A blocked required scenario prevents release. |
| Fail               | An observable outcome differs from the contract.                                                                   |

V1 requires zero open P0/P1 defects. P2 items require explicit product-owner acceptance and release-note disclosure.

## Acceptance environments

| ID      | Environment                                                  | Required V1 scope                                                                   |
| ------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| ENV-MAC | Current macOS Tahoe `26.x` Apple Silicon, currently `26.6.1` | TUI, app-data, Keychain, workspace, session, native adapter where enabled           |
| ENV-WIN | Current supported Windows 11 x64                             | TUI, app-data, Credential Manager, workspace, session, native adapter where enabled |

No current macOS run proves Windows behavior. Unsupported operating systems must fail clearly rather than partially execute.

## TUI acceptance gates

### ACC-TUI-01 Installation and stable command

Required outcomes:

- A clean checkout installs with Node `22.23.2`, npm `10.9.8`, TypeScript `5.9.3`, lockfile version 3, and `npm ci` without changing the committed lockfile.
- Every resolved `@earendil-works/pi-*` package is exactly `0.84.1`; the toolchain assertion fails before task execution if the graph is mixed.
- `npm run build` succeeds and the platform-neutral Node launcher starts the TUI through the repository's stable `candy` command. npm creates the appropriate command shim on macOS and Windows.
- The TUI runs Pi through the same Node `22.23.2` line on both platforms and does not require a separately installed Pi CLI.
- Normal use does not require root or Administrator privileges.

Evidence: exact runtime/toolchain report, lockfile digest, build result, redacted launch smoke, command path/shim inspection, and unsupported-platform behavior.

### ACC-TUI-02 Credential setup and privacy

Required outcomes:

- The user can set, replace, query presence, and delete DeepSeek and MiniMax credentials through the TUI.
- The TUI reports only presence; it never reads back a complete credential.
- Temporary environment credentials override the OS store only for the owning trusted process.
- Provider credentials authenticate only to their approved host and never enter sessions, prompts, logs, diagnostics, events, attachments, repositories, tool arguments, or subprocess environments.
- A credential-bearing Candy-managed write, commit, or push is blocked.
- Deleting a credential makes the next provider operation return `needs_credentials` without damaging task history.

Evidence: redacted presence transitions, approved-host metadata without authentication, subprocess-environment assertions, repository/session scans, and a canary write-block report. Complete credentials, reversible hashes, headers, and environment dumps are forbidden evidence.

### ACC-TUI-03 Core coding journey

Required outcomes:

1. the user selects a workspace and creates a task;
2. Candy streams a model response through the Pi Adapter;
3. bounded tool activity is visible without exposing arguments, output secrets, or provider error text;
4. the task performs only an allowed workspace operation;
5. the TUI presents task state, changed files, and the exact bounded diff where applicable;
6. the task completes without an automatic commit or push;
7. reopening Candy shows the completed transcript, tool evidence, task state, and review metadata.

The fixture must produce the expected result, leave unrelated files unchanged, and preserve the credential guarantees of ACC-TUI-02.

### ACC-TUI-04 Lifecycle, control, and recovery

Required outcomes:

- Retry and compaction observations are projected as bounded lifecycle status; a retry does not settle the task early.
- Full-turn cancellation stops the provider/model operation and active tool work without reporting false completion.
- Steering and follow-up messages are accepted only for the current TUI-owned active task and are bounded and redacted.
- A task waiting for approval cannot be controlled through a bypass path.
- Restart never silently resumes and never replays an interrupted prompt, uncertain tool call, or side effect.
- `:resume` without a new continuation displays persisted evidence and requires an explicit new continuation.
- Stale owners and stale revisions cannot mutate current task state.

Evidence: deterministic lifecycle fixtures, cancellation timing and descendant checks where the native adapter is enabled, restart transcript, explicit-continuation test, and stale-owner fencing report.

### ACC-TUI-05 Workspace, tools, and review

Required outcomes:

- Read-only mode rejects mutations and shell execution.
- Auto mode exposes only the contracted, containment-checked workspace tools.
- `/access` presents three user-facing choices: `review` is read-only, `safe` is the default Candy-owned Task Worktree workflow, and `current` explicitly works in the current workspace and allows existing uncommitted changes.
- On an approved macOS host, both writable access modes run ordinary local `npm run` commands offline without a per-command prompt, using only an already-installed selected-workspace `node_modules`; Candy never downloads dependencies implicitly. Safe-workspace network is a one-command approval, while current-workspace tasks do not expose network commands.
- Tool names and output are bounded; control characters, credential-shaped values, arguments, and unbounded output do not leak into the TUI evidence.
- Workspace escape, traversal, symlink/reparse-point, invalid-path, and race fixtures fail closed.
- Git Task Worktrees, when used, are Candy-owned, task-bound, and isolated for concurrent writable tasks.
- `:changes`, `:diff`, explicit apply, and discard preserve the review boundary; Candy never silently commits, pushes, or removes a dirty user worktree.
- Native command containment and process-tree cancellation are independently gated per platform. Until a platform's G2 evidence passes, Shell remains unavailable there.

### ACC-TUI-06 Candy-owned instructions and resource boundary

Required outcomes:

- Global instructions, prompt templates, and declarative Markdown skills load only from the bounded Candy-owned resource root.
- Invalid, oversized, symlinked, out-of-root, non-UTF-8, and credential-bearing resources are rejected or safely redacted.
- Pi default `.pi` resources, external tool configuration, extensions, packages, themes, and unrelated repositories cannot register a tool, command, hook, prompt, or side effect.
- The selected workspace's supported `AGENTS.md` path is bounded and redacted before projection.

Evidence: hostile-resource fixture, source-boundary assertion, diagnostics, and secret scan.

### ACC-TUI-07 Platform and compatibility matrix

Required outcomes:

- ACC-TUI-01 through ACC-TUI-06 pass on ENV-MAC and ENV-WIN for the capabilities enabled on each platform.
- Platform-specific path, credential-store, process, lock, cancellation, and native-runner behavior uses the narrow adapter rather than POSIX assumptions.
- Windows evidence is produced on Windows 11; macOS evidence does not substitute for it.

### ACC-TUI-08 Local responsiveness

Targets are measured over ten runs on each required platform, excluding provider and public-network latency:

| Metric                                                   | V1 target                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| TUI cold start to usable prompt                          | p95 at or below 2 seconds                                     |
| Local Runtime event to visible TUI projection            | p95 at or below 200 ms                                        |
| User cancellation to provider stream stop request        | at or below 2 seconds                                         |
| User cancellation to task-owned process-tree termination | at or below 5 seconds where Shell is enabled                  |
| Three concurrent tasks                                   | no presentation freeze longer than 1 second and no event loss |

Provider first-token and completion time are reported separately and are not attributed to Candy.

## V2 deferred scope

The following are explicitly deferred and must not be reported as V1 failures or V1 passes:

- Electron Desktop renderer/main/preload, app-server protocol, packaging, signing, tray behavior, and Desktop responsiveness;
- Browser Workspace, Browser Profile, site permissions, physical-input takeover, downloads, screenshots, and Browser security;
- cross-client session inspection and handoff;
- Desktop-specific multimodal attachment UX;
- Desktop tray long-running tasks and the full Auto Debug workflow.

V2 requires a separate scope and acceptance contract. Existing V2 code or historical reports do not satisfy any TUI V1 gate.

## Evidence package and final decision

Each candidate produces a local reviewable package containing the source revision, lockfile digest, protocol/schema versions, exact runtime and dependency versions, platform and architecture, installation type, one row per TUI gate, sanitized tests, relevant screenshots or diffs, timing summaries, open defects, and a secret-scan attestation.

The package must not contain provider credentials, reversible credential fingerprints, unrelated source, unneeded prompts or sessions, browser authentication data, or full process environments.

Candy V1 is accepted only when ACC-TUI-01 through ACC-TUI-08 pass on both required platforms, required live contracts pass for enabled providers, no P0/P1 defects remain, and the product owner approves the evidence package.
