---
status: accepted
---

# Enable macOS Full access as a credential-isolated Personal Preview

## Context

Candy needs an explicit macOS path for experienced developers who require a
Codex-class coding loop with broad local-file and network access. Calling the
existing Trusted Shell Auto capability “Full access” would be inaccurate: it
is a Task-Worktree-only, offline capability with one-command network
elevation.

A raw child process under the same macOS login would also be inaccurate for
Candy. Clearing its environment prevents inherited provider keys, but does not
by itself prevent a child from requesting the user's Keychain. Candy's
provider-credential boundary remains an invariant in every permission mode.

## Decision

Candy exposes `/access full` only on the source-attested macOS Tahoe arm64
Personal Preview host. The TUI displays a prominent warning; the user must
then enter `/access full confirm`. That acknowledgement becomes a local
default for future Auto Git tasks and survives a TUI restart, until `/access
safe` (or the `review` or `current` access choices) turns it off. Each task
persists its own `full_access` decision, independent of later preference
changes. The status chrome continuously shows an amber `⚠ FULL ACCESS` badge
and the `/access safe` escape route. Before activation, the macOS Safe chrome
exposes a clickable `⚠ 开启 Full access` entry that reveals the warning, then a
separate clickable `⚠ 确认开启 Full access` acknowledgement. Neither one-click
action alone can enable the mode.

For that task the Native Sandbox Runner receives `fullAccess: true` and
`network: true`. Its macOS Seatbelt profile grants broad filesystem read/write,
process execution, and networking instead of the ordinary workspace and
network restrictions. It still clears the child environment, rejects
credential material in the runner request, bounds output, owns the process
tree, and retains cancellation and parent-loss cleanup.

The Full access Seatbelt profile explicitly denies the Keychain IPC endpoints
used by `securityd` and SecurityServer. This is the narrow exception to broad
local access required to keep Candy provider credentials outside task
processes. Provider credentials, sessions, prompts, tool arguments,
diagnostics, transcripts, and child environments remain unavailable to the
task.

Full access does not authorize Candy-managed commit, push, publishing, release,
or deployment. The existing publication guard, bounded tool evidence, explicit
recovery, and exclusive task ownership remain in force. Windows Full access is
unavailable; no macOS evidence enables it there.

## Consequences

- The mode is a real macOS filesystem/network capability, not a rename of
  Local Workspace or Trusted Shell Auto.
- Full access retains a small OS boundary for provider credentials, so it is
  not a promise to expose every macOS service to an agent-generated process.
- A task still starts in a Task Worktree by default. That task location is
  independent from its broader command filesystem/network authority.
- The persistent preference is local application state, never a task prompt,
  credential, session payload, or model-visible setting.
- Full access is a Personal Preview capability, not V1 release or Windows
  acceptance evidence.

## Required evidence before broader enablement

The current macOS host must independently demonstrate, with disposable test
fixtures and no credential values in evidence:

1. read/write outside the selected workspace and outbound networking both work;
2. a provider credential is absent from every task child environment, request,
   transcript, diagnostic, and bounded output sink;
3. a disposable Keychain canary cannot be read by the Full access task;
4. cancellation and parent loss terminate ordinary and detached descendants;
5. publication commands remain denied and interrupted tasks require explicit
   continuation.

Failure of any credential, process-tree, cancellation, or output-redaction
check disables the macOS Full access composition root rather than falling back
to an unsandboxed child.

## Reverification and remaining evidence

`npm run smoke:full-access:macos` is the repeatable, temporary-directory-only
macOS evidence for broad external filesystem access, loopback networking,
credential-environment removal, cancellation of detached descendants, and
parent-loss cleanup on the Full access runner path.

It intentionally does not create a Keychain item. The disposable Keychain
canary remains a separate required check: before running it, an operator must
explicitly approve the exact temporary-keychain create, host-side readback,
Full-access denial, and deletion/readback-cleanup sequence. Its command must
never print the canary value, a full Keychain listing, or a process environment.

`npm run smoke:full-access:keychain-canary:macos` implements that exact
reversible sequence. It creates a randomly named temporary Keychain with a
random non-provider record, proves the host can read it without capturing
output, requires the Full access runner read to fail without exposing the
record, then deletes the Keychain and verifies that its file is gone.
