# Coding-agent permission patterns: source-study archive

Status: archived product research; not an implementation record or an accepted ADR

Reviewed: 2026-08-28

## Purpose and boundary

This record preserves product-level observations from the user-provided
open-source coding-agent and API-client source studies. It is a reminder for
later Candy work, not a source of runtime dependencies, copied implementation,
or permission authority.

Candy remains the owner of Task policy, workspace policy, approvals,
credentials, recovery, change review, and the user-facing transcript. Pi
remains the narrow agent-runtime adapter, and the Sandbox Runner remains a
narrow operating-system containment helper. The current V1 scope and accepted
ADRs prevail over an observation in any external source.

The official permission documentation named by the Permission Experience Spec
is the product-level reference. Source observations are useful only after they
also pass the Candy acceptance and platform evidence requirements.

## Source-study conclusion

The durable product pattern is not a particular upstream access-mode name or
runtime implementation. It is a task-bound policy that independently projects:

1. the technical filesystem boundary;
2. the technical network boundary;
3. the approval route for an action that crosses a boundary; and
4. the execution context: a Task Worktree by default, or an explicitly chosen
   Local Workspace when the user's existing changes matter.

The product should present one understandable permission choice while retaining
those independent facts in the persisted Candy Task evidence. A review or
automatic decision does not itself grant filesystem or network capability.

## Adoption register

| Candidate product capability | Source-study observation | Candy decision and value | Status | Required evidence before enabling | Revisit trigger |
| --- | --- | --- | --- | --- | --- |
| One task-policy projection | Mature coding agents keep sandbox capability and approval routing distinct, then apply the resulting policy to all local commands, not only file tools. | Keep one Candy task-creation decision that projects to Tool Host visibility, workspace scope, process policy, network policy, and approval handling. This avoids per-tool permission drift. | **Next permission-experience slice**; design is recorded, not implemented. | Observable TUI choice to effective-policy mapping; table-driven filesystem, command, network, cancellation, and recovery tests. | The Permission Experience Spec is accepted for implementation. |
| Contextual workspace choice | Isolation is a separate concern from how often the user is interrupted. | Default writable work to a Task Worktree. Offer Local Workspace only when it explains a material consequence of existing user changes. | **Retain and improve**. | Dirty-workspace explanation; worktree creation, review, Apply Changes, discard, concurrent-task, submodule, symlink, and reparse-point tests. | A task needs user changes that are absent from its Task Worktree. |
| Effective-policy receipt | Useful approval systems persist the exact boundary, reviewer route, and action reason rather than relying on an opaque mode label. | Persist and display a bounded, redacted effective-policy receipt: user choice, execution context, allowed roots, network state, platform gate, and each escalation decision. | **Next permission-experience slice**. | Restart/readback test; no credentials, arguments, unbounded output, or provider errors in the receipt. | Any approval is paused, denied, resumed, or recovered. |
| Deterministic approval review | Automatic review is valuable only at an already-enforced boundary; a denial must not invite equivalent bypass attempts. | For **Approve for me**, use a Candy-owned deterministic review policy with bounded rationale, action equivalence, a retry circuit breaker, and an explicit user path for a narrowly scoped retry. Do not introduce a reviewer-agent platform for V1. | **Next permission-experience slice**, behind the existing one-agent-per-Task boundary. | Approved, denied, timeout, transformed-command retry, circuit-breaker, and user-exact-retry tests. | The normal flow produces excessive approval fatigue after the sandbox boundary is proven. |
| Network as a real capability | Domain or method policy is meaningful only when it is enforced by the command execution path; a configuration value alone is not proof. | Model network separately as off, bounded, or unrestricted. Preserve the current one-command network approval in safe work until a broader capability is evidenced. | **Current bounded behavior retained**; broader policies are deferred. | Independent egress observation for allow, deny, destination/method rules, timeout, cancellation, and descendant processes. | A supported workflow needs repeatable network access beyond the one-command rule. |
| Full access as an earned package | Broad access is a capability claim, not a rename of a current-workspace option. | Start with a macOS-only Personal Preview after a separate product decision. It may grant the task process broad filesystem and network scope, but never provider credentials, Candy-managed publication authority, a privileged OS identity, or an automatic recovery/retry right. Windows remains unavailable until it has its own accepted capability attestation. | **macOS-first Personal Preview candidate; unavailable until proven**. | On the accepted macOS arm64 host: explicit warning/confirmation; broad filesystem and network behavior readback; provider-credential, Keychain-access, subprocess-environment, transcript, and diagnostic negative tests; process-tree cancellation/parent loss; output redaction; no automatic commit/push/publish; explicit recovery. Windows evidence is a separate future gate. | A new macOS Full Access Personal Preview ADR is accepted, then the macOS evidence package passes. |
| Provider-neutral lifecycle evidence | Agent runtimes and streaming API clients need ordered lifecycle/tool observations to continue correctly; a transcript should not be reduced to only display text. | Continue to project Pi lifecycle into Candy-owned bounded events and persist only the material needed for explicit continuation and review. | **Retain and harden**. | Retry/compaction, cancellation, uncertain-tool-result, restart, stale-owner, and explicit-continuation tests. | A provider introduces a new stream event or cancellation behavior. |
| Security review as a separate task | Security scanners benefit from explicit finding, validation, scope, and remediation evidence; deep scans can involve durable state and parallel agents. | Consider a distinct, opt-in security-review Candy Task only after V1. It must not become an implicit reviewer, source uploader, cloud service, or multi-agent subsystem in the ordinary coding loop. | **V2 research candidate**. | Explicit scope/consent, zero Candy-operated source upload, finding validation, redaction, and remediation-before/after evidence. | Product owner accepts a post-V1 security-review use case. |
| Managed/custom organization profiles | Some coding products allow administrators to constrain available profiles. | Defer. Candy V1 is local-first and single-user; an organization policy plane is not implied by a local preference. | **Out of V1**. | A separate managed-installation product contract, admin provenance, conflict rules, privacy review, and acceptance plan. | A managed-distribution requirement is accepted. |
| Browser, handoff, and multi-agent control | Browser and delegation surfaces have their own authorization and data-flow risks. | Do not inherit them from the source study. Browser needs its own V2 security contract; handoff and multi-agent orchestration remain out of V1. | **Out of V1**. | Separate product decision and acceptance contract; no V1 evidence can enable either. | V2 scope explicitly includes one of these surfaces. |

## Non-adoption rules

- Do not import an external agent runtime, API client, scanner, or its internal
  source implementation as a shortcut for Candy control-plane behavior.
- Do not copy upstream access-mode names, configuration keys, policy prompts,
  browser behavior, credential behavior, or platform-specific sandbox code.
- Do not turn an automated approval decision into a capability grant.
- Do not allow a task, tool output, external page, skill, or plugin to expand
  the user authorization recorded for that Candy Task.
- Do not treat a successful source build, configuration readback, or unit test
  from an external project as Candy platform or business acceptance evidence.

## Candy document and scope check

The Permission Experience Spec is a discussion draft. Its proposed permission
experience must not be presented as the current TUI contract until a vertical
slice passes the acceptance evidence below.

Current Candy V1 product and acceptance documents make the TUI-only scope
authoritative for release acceptance; Desktop, Browser Workspace, Browser
Profile, and Auto Debug are deferred. Historical ADR wording that mentions
those deferred surfaces is design history, not evidence that they are V1
enabled. Resolve that documentation drift explicitly before a permission change
would rely on one of those surfaces.

### macOS-first Full access interpretation

The accepted macOS Trusted Shell Auto preview is not Full access: it is limited
to a Task Worktree, offline ordinary commands, and a one-command network
approval. A macOS-first Full access preview may be a later V1 capability, but
it needs a separate ADR rather than a label change to that existing preview.

For this preview, "Full access" means broad filesystem and network scope for
the task process under the ordinary user account. It does not mean access to
provider credentials or the OS credential store through a command, administrator
or root authority, Candy-managed commit/push/publish/release/deploy authority,
or permission to silently replay an interrupted operation. Those exclusions
must be proven with negative tests; removing credentials from the child
environment alone is insufficient.

## Evidence package for the future permission slice

Before declaring any row above enabled, attach a source-bound evidence package
with:

1. the exact source revision, lockfile, Node/npm/TypeScript/Pi versions,
   platform version and architecture;
2. a visible TUI journey for normal coding, an approval pause, denial, a safe
   retry path, completion, and recovery at narrow and ordinary terminal widths;
3. a behavior matrix for every permission choice and execution context,
   including outside-root operations, local validation with and without
   installed dependencies, network operations, and cancellation;
4. independent native macOS and Windows negative matrices where process
   capability is enabled; and
5. secret-safe evidence only: no provider credential, reversible fingerprint,
   complete tool argument, full process environment, or unbounded tool output.

## Maintenance rule

Review this register whenever the Permission Experience Spec changes, a native
platform gate changes, a new external-action surface is proposed, or V2 scope
is opened. Closing a row requires an accepted product decision, the listed
evidence, and an update to the applicable product/acceptance document; this
archive alone never closes a gate.
