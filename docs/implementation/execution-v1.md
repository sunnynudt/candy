# Candy V1 Execution Contract

Status: implementation authorized

This document turns the accepted implementation plan into an execution contract for long-running Codex work. Product scope and security invariants remain authoritative in `AGENTS.md`, `docs/product/candy-v1.md`, and accepted ADRs.

## Execution rule

Implement `docs/architecture/implementation-plan-v1.md` in phase order. At each checkpoint:

1. inspect the current Git diff and preserve unrelated changes;
2. implement the smallest runnable vertical increment;
3. run the applicable deterministic checks;
4. fix failures before moving on;
5. update `docs/implementation/progress-v1.md` with evidence;
6. record unavailable external evidence in `docs/implementation/blockers-v1.md` and continue independent work;
7. commit the coherent checkpoint, push it to the canonical branch, and verify remote synchronization before starting the next work packet.

An unresolved Gate blocks capability availability, acceptance, and release claims. It does not require placeholder code, guessed compatibility, or stopping unrelated implementation.

## Canonical local checks

Phase 1 establishes these root commands and keeps them stable:

```text
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run check:boundaries
npm run check:pi-versions
```

Later phases add focused contract, integration, packaging, and end-to-end commands without changing the meaning of the root checks.

## Branch continuity and cloud durability

- `codex/candy-v1-foundation` is the canonical V1 implementation and delivery branch.
- Fetch the canonical remote branch before changing code. Fast-forward if it is ahead; do not continue automatically when histories diverge.
- Keep commits scoped to coherent, verified checkpoints and preserve unrelated user changes.
- Scan staged content for provider credentials and other credential material before every commit and push.
- Push every successful checkpoint commit to `origin/codex/candy-v1-foundation`, then verify that the local and remote commit identifiers match.
- Never force-push, rewrite published history, or use another delivery branch unless the user explicitly changes this policy.
- If synchronization fails after bounded retries, record the exact failure and stop before starting another work packet. A local commit is not a durable checkpoint until the remote verification succeeds.

## Unattended behavior

- Do not ask for credentials, account access, signing identities, or target machines during an unattended run.
- Do not inspect another coding tool's configuration or credential storage.
- Mark missing external resources Blocked and continue independent work.
- Never weaken a security invariant to make a test pass.
- Never claim macOS, provider, signing, sandbox, or packaged-runtime acceptance without the required evidence.
- Checkpoint commits and pushes to `origin/codex/candy-v1-foundation` are authorized and required by the branch-continuity policy. Pull requests, publishing, release, and deployment remain prohibited unless separately authorized.

## Phase 2 checkpoint

After Phase 2, answer the five checkpoint questions in the implementation plan. Deterministic failures in questions 1 through 4 must be fixed before continuing. Missing external evidence for question 5 is recorded as Blocked; later independent implementation may continue but the affected acceptance claim remains unavailable.

## Stopping condition

Stop when all implementable work packets have code and deterministic evidence, and every remaining item requires a named external resource or unresolved security review. The final report distinguishes Pass, Fail, Controlled failure, and Blocked exactly as defined by the acceptance standard.
