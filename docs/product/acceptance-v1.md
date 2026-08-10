# Candy V1 Product Acceptance Standard

Status: accepted acceptance contract

This document defines how Candy V1 is judged complete. Product scope comes from [Candy V1](candy-v1.md), implementation order comes from the [coding implementation plan](../architecture/implementation-plan-v1.md), and this document supplies the observable outcomes and evidence required to accept each slice and the final product.

Passing unit tests alone is not product acceptance. Candy V1 is accepted only when its required user journeys, security invariants, provider contracts, recovery behavior, and platform targets all pass with reviewable evidence.

## Acceptance policy

- Required platforms are macOS `26.5.2` on Apple Silicon and Windows 11 x64.
- Every deterministic test must pass. A flaky retry does not convert a failure into a pass.
- Every required live-provider contract must pass with real credentials through the same Pi Adapter and Provider path used by the product.
- A provider or network failure may produce a controlled, actionable product result; it must never produce silent fallback, state corruption, or secret exposure.
- Any security invariant failure, credential exposure, uncertain side-effect replay, workspace escape, or cross-task control violation blocks release.
- A capability hidden behind an unfinished Gate is not accepted merely because its UI is disabled. Every capability listed as required V1 scope must pass before V1 release.
- Results are recorded against an exact build, lockfile, operating system patch, architecture, Electron/Node/Pi versions, and test fixture revision.

## Result classifications

| Result             | Meaning                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass               | All stated outcomes and evidence requirements are satisfied.                                                                                      |
| Controlled failure | The dependency failed, but Candy preserved safety and returned the specified actionable state. Used only where the scenario explicitly allows it. |
| Blocked            | Required environment, credential, entitlement, or platform capability is unavailable. A blocked required scenario prevents release.               |
| Fail               | An observable outcome differs from the contract.                                                                                                  |

Defects are release-classified as:

- **P0**: credential exposure, data loss, sandbox escape, unauthorized external side effect, cross-task ownership violation, or unrecoverable corruption;
- **P1**: a required V1 user journey cannot complete on a supported platform or provider;
- **P2**: a significant defect with a usable documented workaround;
- **P3**: cosmetic or low-impact behavior that does not change the contracted outcome.

V1 release requires zero open P0 and P1 defects. P2 items require explicit product-owner acceptance and release-note disclosure.

## Acceptance environments

### Platform matrix

| ID      | Environment                               | Required scope                                                                                   |
| ------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| ENV-MAC | macOS `26.5.2` on Apple Silicon           | TUI, signed/notarized Desktop, Sandbox Runner, Keychain, Browser, worktrees, recovery            |
| ENV-WIN | Current supported Windows 11 patch on x64 | TUI, signed Desktop, Sandbox Runner/Job Object, Credential Manager, Browser, worktrees, recovery |

Older macOS versions, Intel macOS, and Windows versions before Windows 11 are not V1 acceptance targets.

### Controlled fixture set

Acceptance uses Candy-owned fixtures containing no private source or credentials:

1. a small Git TypeScript project with a reproducible failing test, an untracked file, a binary file, and a clean expected patch;
2. a non-Git project with one reproducible file change;
3. a local web application with navigation, forms, authentication placeholders, downloads, destructive-action prompts, and deterministic visual assertions;
4. a fixed image fixture for MiniMax M3 understanding;
5. long-running command fixtures that spawn descendants, emit large output, stall, succeed, and ignore graceful cancellation.

Model-controlled outcome scenarios run three times from clean fixture state. The required result is at least two successful outcomes out of three, with zero security, ownership, or secret-handling failures across all attempts. Deterministic infrastructure and policy scenarios must pass every run.

## Acceptance Gates

### ACC-01 Installation and first run

Required outcomes:

- TUI and packaged Desktop install and launch on both acceptance platforms.
- A clean source install uses Node `22.23.2`, npm `10.9.8`, TypeScript `5.9.3`, lockfile version 3, and `npm ci` without changing the committed lockfile.
- Every resolved `@earendil-works/pi-*` package is exactly `0.84.1`; a mixed Pi graph or unsupported agent-runtime Node version fails before task execution.
- TUI and packaged Desktop app-server execute the Pi Adapter under the same Node `22.23.2` runtime. Electron's embedded Node is reported separately and no Pi package is loaded by Electron main or renderer.
- Normal Candy use does not require running the complete application as root or Administrator.
- Desktop starts its app-server child, reports its exact protocol/runtime versions, and terminates it on explicit application quit.
- First run explains credential setup, workspace selection, Read-only versus Auto, Browser Profile, and the absence of Candy cloud execution.
- Unsupported operating systems fail with a clear message rather than partial execution.

Evidence: signed artifact identifiers, exact runtime/toolchain report, lockfile digest and clean-install assertion, redacted Pi install-tree assertion, launch timings, process tree snapshot without command environments, screenshots, and redacted diagnostic summary.

### ACC-02 Credential setup and privacy

Required outcomes:

- The user can set, replace, query presence, and delete DeepSeek and MiniMax credentials.
- The renderer never reads back a complete credential.
- Temporary environment credentials override the OS credential store only for the owning trusted process.
- Provider credentials authenticate only to their approved hosts and never enter sessions, prompts, logs, diagnostics, events, SQLite, attachments, Browser data, repositories, or tool subprocess environments.
- A canary credential intentionally placed in the trusted credential path is detected and blocked if a Candy-managed write, commit, or push would contain it.
- Deleting a credential makes the next provider call return `needs_credentials` without damaging the task.

Evidence: canary scan report, credential presence transitions, approved-host request metadata with authentication removed, subprocess environment assertion, and repository/session scans. Complete credentials, reversible hashes, headers, and environment dumps are forbidden evidence.

### ACC-03 Core coding journey

Given the failing TypeScript fixture and DeepSeek V4 Flash selected by default:

1. the user creates a task from TUI or Desktop;
2. Candy streams model output;
3. the agent reads the workspace through a visible tool call;
4. the agent proposes and performs an allowed edit;
5. the validator passes;
6. Candy presents changed files and the exact diff;
7. the task completes without an automatic commit or push;
8. reopening Candy shows the completed transcript, tool results, validator evidence, and diff.

The expected fixture behavior must be correct, unrelated files must remain unchanged, and the provider credential must pass ACC-02 throughout.

### ACC-04 Model portfolio and multimodal behavior

Required outcomes:

- A new task defaults to `deepseek-v4-flash`.
- `deepseek-v4-pro` is selectable and uses the same approved DeepSeek Chat Completions host without silent aliasing.
- `MiniMax-M3` is selectable and all requests use the domestic MiniMax Anthropic-compatible host.
- Model switching is allowed only between turns and is visible in task history.
- A DeepSeek task receiving an image offers an explicit switch to MiniMax M3; it never performs a hidden secondary vision call.
- MiniMax M3 receives the controlled image and produces an answer grounded in image content.
- Provider error, cancellation, and rate limiting offer explicit retry, model change, or cancellation without silent cross-provider fallback.
- Video input remains unavailable in the Pi 0.84.1 path.

Live contract IDs `LIVE-DS-01` through `LIVE-DS-04` and `LIVE-MM-01` through `LIVE-MM-05` from [Compatibility Gate 0](../research/compatibility-gate-0.md) are mandatory evidence.

### ACC-05 Sessions and cross-client ownership

Required outcomes:

- TUI and Desktop read the same Candy-owned task/session after workspace remapping where needed.
- Exactly one Execution Owner can advance a task. A second client is read-only and receives a clear ownership state.
- Handoff waits for the current turn and tools to stop, persists completed results, releases ownership, and starts only a new turn in the receiving client.
- An in-flight tool call is never migrated or replayed.
- Pi's default session directory remains untouched.

### ACC-06 Bounded parallel tasks

Required outcomes:

- Three tasks execute concurrently by default.
- A fourth task queues in FIFO order and can be reordered or cancelled.
- Configuration above five is rejected.
- DeepSeek rate limiting does not block MiniMax calls or unrelated local reads.
- Multiple writable tasks for one Git repository receive different Task Worktrees.
- A non-Git project permits one writer while other tasks remain read-only or queued.

Evidence includes task/lease generations, queue transitions, workspace identities, and redacted provider timing; it must not include prompts or credentials not required for the assertion.

### ACC-07 Permissions, sandbox, and cancellation

Required outcomes:

- Read-only rejects file mutation and Shell execution.
- Auto permits contracted workspace operations but denies workspace escape and model-command network access through OS containment, not only policy prompts.
- Symlink, junction, reparse-point, case, traversal, and race fixtures cannot write outside the allowed workspace.
- Network, destructive actions, commits, pushes, releases, deployments, and sensitive external effects request the correct approval.
- Denial leaves the task resumable and does not partially execute the action.
- Provider credentials are absent from the Sandbox Runner request and target environment.
- Cancellation ends the model stream promptly and terminates the complete Shell descendant process tree; Windows verification proves Job Object ownership.
- Candy never reports cancellation complete while a task-owned descendant remains running.

G2 must pass independently on both platforms before Shell-enabled Auto or Shell-based Auto Debug is accepted there.

### ACC-08 Workspace, Worktree, and Apply Changes

Required outcomes:

- Task Worktrees are created through Git's porcelain contract from a recorded base and stay associated with one task.
- Changed tracked, binary, and untracked files appear in review.
- Apply Changes transfers the reviewed patch as uncommitted changes without modifying the target index unexpectedly.
- Dirty target, changed base, conflict, secret match, submodule risk, or path mismatch stops safely with actionable recovery.
- Candy never silently commits, merges, pushes, force-removes a dirty worktree, or initializes Git.
- Non-Git change review correctly reports added, changed, and removed files.

### ACC-09 Desktop security and Browser Workspace

Required outcomes:

- The renderer has no Node, filesystem, credential-store, raw IPC, app-server, Session, WebContents, or CDP access.
- Remote pages receive no Candy preload or provider credential and run under default-deny permission policy.
- The user and agent operate the same visible WebContents and Candy-owned persistent Browser Profile.
- A site must be allowed before agent operation; sensitive submission, purchase, deletion, publication, permission change, and full debug access require explicit confirmation.
- Every Browser action references an observation revision; stale actions fail.
- Verified physical interaction transfers Browser Control to the user. Where reliable origin detection is unavailable, visible Take Control performs the transfer and cancels the conflicting action.
- The agent cannot silently retake control.
- Downloads are visible, use the configured destination, and never auto-open or automatically enter model context.
- Automated file upload is unavailable.
- A Browser screenshot becomes an attachment for MiniMax without exposing cookies, passwords, storage tokens, or authentication headers.

### ACC-10 Long-running Tasks and Auto Debug

Required outcomes:

- The task begins with an explicit outcome, validator, constraints, and optional budget.
- Auto Debug reproduces the fixture failure, records evidence, performs normal agent turns, reruns the same validator, and completes only when it passes.
- The user can pause, resume, steer, and cancel while Candy remains running.
- Waiting approval, budget exhaustion, repeated unchanged evidence without a meaningful workspace delta, ownership loss, provider failure, and user stop produce distinct persisted stop reasons.
- Closing the Desktop window may continue in the tray; explicit application quit cancels and records interruption.
- Restart never silently resumes and never replays an uncertain Shell or Browser action.
- Auto Debug does not broaden model, workspace, sandbox, network, approval, Browser site, or provider permissions and never auto-commits, pushes, releases, or deploys.

### ACC-11 Recovery and data integrity

Required outcomes:

- Process termination before, during, and after a metadata transaction preserves a valid database and at most one current fenced owner.
- A crashed tool call becomes Interrupted; only completed messages and tool results are resumable.
- Old owners cannot mutate task state after a fencing generation changes.
- WAL, migration, backup, restore, unknown future schema, disk-full, and corrupted-data fixtures have explicit behavior.
- Application upgrade preserves accepted task/session/attachment data or provides a tested rollback path.
- Browser Profile clearing and credential deletion do not delete task history; task deletion does not silently retain attachments.

### ACC-12 Local responsiveness

Targets are measured over ten runs on each acceptance machine, excluding provider and public-network latency:

Execution order follows host availability: complete the ten-run measurement on the current `ENV-MAC` macOS `26.5.2` Apple Silicon machine first. The identical `ENV-WIN` measurement remains a `G0-WIN` pending task until a Windows 11 x64 host is available. Both measurements remain required before a final cross-platform V1 release claim.

| Metric                                                   | V1 acceptance target                                       |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| TUI cold start to usable prompt                          | p95 at or below 2 seconds                                  |
| Desktop cold start to task list                          | p95 at or below 5 seconds                                  |
| Local Runtime event to visible UI projection             | p95 at or below 200 ms                                     |
| User cancellation to provider stream stop request        | at or below 2 seconds                                      |
| User cancellation to task-owned process tree termination | at or below 5 seconds                                      |
| Browser Take Control to disabled agent action            | at or below 500 ms                                         |
| Three concurrent tasks                                   | no presentation freeze longer than 1 second; no event loss |

Provider first-token and completion times are reported separately and are not attributed to Candy. Candy overhead from dispatch to provider request start is recorded and regressions above 20% require investigation.

## Slice-to-acceptance traceability

| Implementation slice     | Required Acceptance Gates                                                              |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Compatibility Gate 0     | ACC-01 environment subset, ACC-02 canary path, ACC-04 live contracts                   |
| Repository foundation    | protocol/security harness supporting ACC-02, ACC-05, ACC-11                            |
| Runtime proof            | ACC-02, ACC-03 read-only subset, ACC-04 Flash, ACC-05 session subset                   |
| Task Runtime and TUI     | ACC-03, ACC-05, ACC-06, ACC-11, ACC-12 TUI                                             |
| Model portfolio          | ACC-04 complete                                                                        |
| Desktop shell            | ACC-01 Desktop, ACC-02 Desktop, ACC-05 Desktop, ACC-09 renderer subset, ACC-12 Desktop |
| Local control/workspaces | ACC-07, ACC-08, ACC-11 process/lease subset                                            |
| Browser Workspace        | ACC-09 complete                                                                        |
| Long-running/Auto Debug  | ACC-10 complete                                                                        |
| Release hardening        | all ACC-01 through ACC-12 on both platforms                                            |

An implementation slice is not complete until its mapped Acceptance Gates pass. A later slice may not waive an earlier failed Gate.

## Acceptance evidence package

Each candidate release produces a local, reviewable package containing:

- build identifier, source revision, lockfile digest, protocol/schema versions, and exact dependency/runtime versions;
- platform and architecture, installation type, and operating-system patch;
- one row per Acceptance Gate with Pass, Controlled failure, Blocked, or Fail;
- sanitized test output, screenshots, diffs, state transitions, timing summaries, and crash/recovery results needed to reproduce the judgment;
- the list of open P2/P3 defects and accepted limitations;
- an explicit secret-scan attestation for the evidence package itself.

The package must not contain source from unrelated projects, provider credentials, reversible credential fingerprints, prompts or sessions not required by the fixture, browser authentication data, or full process environments.

## Final V1 acceptance

Candy V1 is accepted only when:

1. ACC-01 through ACC-12 pass on both required platforms;
2. every live DeepSeek and MiniMax contract passes with the intended account types;
3. zero P0/P1 defects remain;
4. all accepted ADR and security invariants are represented in observable tests;
5. the product owner reviews the evidence package and explicitly approves the candidate build.
