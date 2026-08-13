# Candy V1 Coding Implementation Plan

Status: implementation authorized; capability enablement and release claims remain blocked by their unresolved Gates

This plan begins after the technical plan and conditional Compatibility Gate 0 decision are accepted. Product coding is authorized. Work proceeds as vertical slices; an unresolved live or platform Gate blocks enabling and accepting the affected capability, but it does not block independent code, deterministic fixtures, disabled adapters, or later work that does not rely on the unproved behavior. A slice is complete only when its mapped gates in the [Candy V1 Product Acceptance Standard](../product/acceptance-v1.md) pass with the required evidence.

## Rules of execution

- Preserve the accepted product and security invariants in `AGENTS.md` and `docs/product/candy-v1.md`.
- Pin exact direct dependencies, commit one root lockfile, and assert an exact unmixed Pi package closure when implementation is authorized.
- Treat Pi, the agent-runtime Node major, npm major, and TypeScript minor/major as one compatibility train; do not upgrade them independently.
- Keep each change reviewable and runnable. Do not create empty framework packages for future slices.
- Do not expose a mutable capability in UI before its sandbox, approval, cancellation, and audit behavior is tested.
- Do not claim macOS or Windows support for a slice until that slice passes on the named platform.
- Do not enable a provider label until its official model contract and entitlement pass a live smoke test.
- Run real provider tests only through the [Live Provider Credential Procedure](../testing/live-provider-credentials.md); never read another tool's credential store as a Candy runtime source.
- When an external credential, entitlement, signing identity, security review, or target operating system is unavailable, record a named blocker and continue all independent work. Never convert Blocked into Pass.
- Code behind an unresolved Gate must remain unavailable through capability reporting and UI until the Gate passes on that target platform.
- Do not add a Candy cloud service, daemon, plugin system, multi-agent coordinator, or second workflow engine.

## Phase 0: close Compatibility Gate 0

Deliverables:

1. Verify and record the Pi-compatible baseline: exact Pi package closure, the Pi-tested Node major and security patch, its bundled npm, matching TypeScript, and the separately selected Electron runtime.
2. Verify the public Pi exports used by the Adapter and classify any unavoidable unstable import.
3. Freeze official DeepSeek and MiniMax domestic endpoint, model, authentication, streaming, tool, reasoning, attachment, cancellation, limit, and Token Plan contracts.
4. Select the transactional task metadata implementation and prove it works in the chosen Node and Electron runtimes.
5. Select Browser Workspace and command-sandbox adapters from first-party evidence.
6. Record OS credential, process cancellation, lease, app-data, and Git worktree strategies.
7. Convert every unresolved item into a named blocker with an owner and validation procedure.
8. Record the current macOS Tahoe `26.x` Apple Silicon primary host and freeze the compatible Electron line; retain exact `26.5.2` as a separate regression baseline.
9. Specify the accepted Rust Sandbox Runner protocol and macOS/Windows backend security contract; obtain security review before it can enable Shell.
10. Validate automatic Browser takeover and use the accepted visible Take Control fallback when physical input cannot be distinguished reliably from CDP-synthesized input.

Exit criteria:

- `docs/research/compatibility-gate-0.md` and `docs/research/platform-gate-0.md` are complete;
- `docs/architecture/technical-plan-v1.md` contains no guessed model or package contract;
- the live-test credential path and evidence redaction satisfy `docs/testing/live-provider-credentials.md`;
- at least one officially available DeepSeek text/tool model is approved for the Runtime proof;
- the first mutable shell capability remains gated if G2 is not yet proven.
- Sandbox Runner and Shell integration code may be implemented and tested with deterministic adapters, but Shell-enabled Auto and Shell-based Auto Debug remain unavailable until the accepted native backend passes G2 on the target platform.

## Phase 1: repository foundation and contract harness

Work packets:

1. Create the workspace root with Node `22.23.2`, bundled npm `10.9.8`, TypeScript `5.9.3`, the complete Pi package closure at exact `0.84.1`, one lockfile-v3 `package-lock.json`, package scripts, formatting, linting, type checking, test runner, and dependency policy.
2. Create only `protocol`, `runtime`, `pi-adapter`, and `platform`, plus the TUI proof composition root.
3. Define protocol schemas, secret-forbidden fields, event sequencing, command idempotency, task revisions, and snapshot fixtures.
4. Establish deterministic test adapters for Agent Engine, Platform clock/leases, and Browser unavailable capability.
5. Add Windows and macOS CI jobs for type, unit, protocol, and packaging smoke checks.

Exit criteria:

- a protocol fixture round-trips in-process and over a stdio harness;
- invalid versions, malformed messages, duplicate command IDs, stale revisions, and secret-shaped forbidden fields fail closed;
- dependency checks prove only `pi-adapter` imports Pi packages;
- install-tree checks prove every resolved `@earendil-works/pi-*` package is exactly `0.84.1` and the lockfile remains unchanged after `npm ci`;
- no provider credential is required for the default test suite.

## Phase 2: Runtime proof with Pi

Work packets:

1. Implement the Agent Engine Interface through `@earendil-works/pi-coding-agent@0.84.1` using its documented root SDK export only.
2. Connect `deepseek-v4-flash` through `https://api.deepseek.com/chat/completions` and the trusted Provider path.
3. Stream one turn into normalized Candy events.
4. Wrap one read-only workspace tool with root containment, cancellation, structured outcome, and event projection.
5. Save the Pi session under Candy application data and reload it through a new Runtime instance.
6. Add canary-secret coverage across events, session files, diagnostics, and tool subprocess environment fixtures.

Exit criteria:

- one prompt streams and completes through Pi on macOS and Windows;
- one read-only tool call is authorized, observed, and persisted;
- the same session fixture reloads after workspace remapping on the other operating system;
- no mutable file or shell capability is enabled;
- the canary credential appears only in the approved provider authentication path.

## Phase 3: Task Runtime and TUI

Work packets:

1. Implement task creation, state transitions, one execution owner, cancellation scopes, snapshots, and sequenced events.
2. Implement transactional metadata, FIFO queue, global slot leases, per-task owner leases, heartbeats, and explicit stale recovery.
3. Implement the TUI on the direct Runtime Interface using Pi TUI rendering primitives only where their verified public surface is sufficient.
4. Add Read-only and Auto approval profiles, with unsupported capabilities displayed rather than hidden.
5. Add interruption and explicit-resume behavior; never auto-resume persisted work.

Exit criteria:

- independent TUI processes cannot both own one task;
- global concurrency is three by default and rejects configuration above five;
- queue ordering and cancellation survive process restart;
- crash recovery marks uncertain active work interrupted;
- the TUI can create, run, inspect, cancel, and resume a read-only task.

## Phase 4: model portfolio and attachments

Work packets:

1. Implement the code-owned model catalog and per-provider concurrency/rate-limit gates.
2. Add `deepseek-v4-pro` through the same verified Chat Completions path without silent fallback.
3. Add Pi provider `minimax-cn` with model `MiniMax-M3` through `https://api.minimaxi.com/anthropic/v1/messages` only after Token Plan entitlement, image schema, thinking/tool replay, and cancellation pass live verification.
4. Add attachment ingestion, content hashing, metadata, storage outside session JSONL, and retention cleanup.
5. Add between-turn model switching and an explicit switch prompt when an attachment is incompatible with the selected model.

Exit criteria:

- UI labels map to verified official identifiers and approved hosts;
- provider `429` handling does not block unrelated local tools or the other provider;
- image paste, drag, selection, and stored browser screenshot reach MiniMax through the domestic host only;
- provider failure offers retry, explicit model change, or cancel and never silently reroutes;
- video UI remains disabled unless its separate contract gate passes.

## Phase 5: Desktop shell and trusted process path

Work packets:

1. Create Electron `43.2.0` main, sandboxed preload, renderer, and the app-server child composition root for current macOS Tahoe `26.x` Apple Silicon and Windows 11; package and sign Node `22.23.2` as the app-server runtime instead of using Electron's Node mode.
2. Implement versioned JSONL stdio transport, backpressure, line limits, child executable/entry integrity checks, restart inspection, and graceful parent/child shutdown; close the Electron `runAsNode` fuse.
3. Implement the dedicated credential bridge and `@napi-rs/keyring@1.3.0` OS credential adapter; renderer receives presence state only.
4. Implement task list, task detail, streaming transcript, tool visibility, approval UI, changed-file list, and diff review.
5. Implement tray/menu-bar behavior and explicit-quit cancellation.

Exit criteria:

- renderer has no Node, filesystem, credential-store, CDP, or raw app-server access;
- app-server termination never leaves an executing task marked Running;
- complete credentials are not readable through renderer or Runtime protocol;
- TUI and Desktop can inspect the same saved task, but only one can advance it;
- window close and explicit application quit have the accepted distinct behavior.

## Phase 6: local control and workspace concurrency

Work packets:

1. Implement action classification, approval policy, serial mutation lane, clean subprocess environments, and command cancellation.
2. Implement the isolated Rust Sandbox Runner and its versioned JSONL stdio Adapter; verify macOS containment and Windows containment plus Job Object ownership before enabling mutable shell commands in Auto.
3. Implement Local Workspace leases and non-Git single-writer change manifests.
4. Implement Task Worktree creation from a recorded base, task association, cleanup, and recovery.
5. Implement reviewed Apply Changes using a binary-safe patch and untracked-file manifest without mutating the user's index.
6. Add credential-content blocking for Candy-managed writes, commits, and pushes.

Exit criteria:

- workspace escape and command network are denied by the sandbox, not only by prompt policy;
- approval is still required for network, destructive, Git-publish, release, deploy, and other external side effects;
- concurrent writable tasks for one Git repository never share a worktree;
- dirty target, changed base, secret match, and patch conflict stop Apply Changes safely;
- cancellation terminates the command process tree on both operating systems.

If G2 cannot pass on either platform, the phase remains blocked and Candy does not advertise the default Auto profile on that platform.

## Phase 7: Browser Workspace

Work packets:

1. Create the visible `WebContentsView` Browser surface and Candy-owned persistent Electron Session in main.
2. Implement allowlisted observation, navigation, click, input, and screenshot operations through `webContents.debugger`, and downloads through `DownloadItem`, behind the Browser Interface.
3. Add monotonic observation revisions and stale-action rejection.
4. Add per-site permission, sensitive-action confirmation, automatic user takeover where verified, the visible Take Control fallback, cancellation, clear-browsing-data, and visible download controls.
5. Connect screenshots to the Attachment store and MiniMax path without exposing browser authentication data.
6. Add a local adversarial fixture site for prompt injection, navigation races, popups, downloads, authentication placeholders, and sensitive submissions.

Exit criteria:

- user and agent operate the same visible WebContents and profile;
- verified physical user input or the Take Control action immediately wins control and a stale agent action cannot execute;
- cookies, passwords, storage tokens, headers, and raw CDP output never enter model context or logs;
- automated uploads remain unavailable;
- Browser assertions can validate local and public pages through structured observations.

## Phase 8: Long-running Tasks and Auto Debug

Work packets:

1. Implement outcome, validator, evidence, budget, progress fingerprint, and stop-reason persistence.
2. Add command/test/build validators and Browser assertion validators over existing tool and Browser Interfaces.
3. Implement normal-turn/validator alternation without a second agent loop.
4. Add pause, resume, steering, approval wait, stall detection, explicit quit, provider failure, and crash interruption behavior.
5. Add progress UI and a final evidence summary.

Exit criteria:

- validator success is the only automatic completion condition;
- repeated unchanged evidence and no meaningful workspace delta pause rather than loop forever;
- resume is explicit after restart and never replays an uncertain command or Browser action;
- task permissions, model, workspace, browser sites, and network capability never broaden during long-running execution;
- Auto Debug never auto-commits, pushes, releases, or deploys.

## Phase 9: cross-platform release hardening

Work packets:

1. Run the full current macOS Tahoe `26.x` Apple Silicon and Windows 11 matrix for sessions, credentials, process trees, leases, worktrees, Browser, downloads, tray behavior, and packaging; run the exact `26.5.2` regression matrix separately when that compatibility claim is required.
2. Add migration fixtures for protocol, metadata, and session schema versions.
3. Produce dependency licenses, SBOM, exact lockfile verification, lifecycle-script allowlist, and packaged-artifact smoke tests.
4. Verify install, upgrade, rollback, app-data retention, credential deletion, Browser data clearing, and uninstall behavior.
5. Run the V1 security and recovery checklist with canary credentials and adversarial workspaces/pages.

Exit criteria:

- all earlier slice gates pass on both operating systems;
- a clean machine can install, start, run a task, restart, reload, and uninstall without losing user-reviewed data unexpectedly;
- packaged applications contain only approved runtime dependencies and no development credentials or local paths;
- known limitations are explicit in release notes.
- ACC-01 through ACC-12 pass on both acceptance platforms with zero open P0/P1 defects.

## Required test matrix

Every mutable or external action is tested across these dimensions where applicable:

| Dimension        | Required cases                                                        |
| ---------------- | --------------------------------------------------------------------- |
| Operating system | current macOS Tahoe `26.x` Apple Silicon; Windows 11                    |
| Client           | TUI in-process; Desktop app-server                                    |
| Workspace        | Git clean; Git dirty; Task Worktree; non-Git Local                    |
| Task state       | Running; WaitingApproval; Paused; Interrupted; Cancelled              |
| Provider         | DeepSeek; MiniMax; rate limited; cancelled; malformed stream          |
| Control          | Read-only; Auto; explicit denial; stale approval                      |
| Recovery         | client crash; app-server crash; application quit; stale lease         |
| Security         | secret canary; path escape; network attempt; browser prompt injection |

## First implementation checkpoint

After Phase 2, perform a mandatory Runtime proof review before creating the full TUI or Electron shell. In an unattended Goal, Codex performs this review, records the evidence, fixes deterministic failures, and continues automatically only when questions 1 through 4 pass. Missing macOS or live-provider evidence remains a named blocker under question 5 and does not block independent implementation, but no cross-platform or provider-compatibility claim may be made without it. The checkpoint must answer:

1. Does the pinned Pi public surface support the Adapter without internal imports?
2. Does the approved DeepSeek contract stream tool-capable turns correctly?
3. Does Candy own and reload the session independently of Pi defaults?
4. Is the credential absent from every forbidden sink?
5. Does the same fixture behave on the current macOS Tahoe `26.x` Apple Silicon host and Windows 11?

Failure at this checkpoint changes the Adapter or pinned dependency. It does not justify forking Pi, rewriting its loop, weakening secret isolation, or skipping a supported platform.
