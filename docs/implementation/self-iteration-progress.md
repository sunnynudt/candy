# Candy implementation status and evidence index

Updated: 2026-09-20 (documentation cleanup only; no new acceptance run)

## Scope and authority

The [product contract](../product/candy-v1.md) and [acceptance standard](../product/acceptance-v1.md) define V1: TUI and local WebUI, one agent per task, bounded independent tasks, and separate macOS and Windows evidence. Electron Desktop and Browser Workspace remain V2. Repository execution rules live in [AGENTS.md](../../AGENTS.md).

This file is the maintained entry point for implementation status. It is also read by the Candy self-development journey; keep this path stable. Historical checkpoints do not establish acceptance of the current checkout.

## Recorded evidence

| Area | Recorded result | Evidence and limitation |
| --- | --- | --- |
| macOS TUI and local WebUI candidate | PASS at `34ec232` | [Sanitized candidate package](../evidence/acceptance-v1-macos-34ec232.md): deterministic checks 402/402, macOS acceptance 14/14, and scoped operator-surface evidence. Not a current-HEAD or Windows result. |
| macOS self-development, live providers, and WebUI lifecycle | Historical passes at individually named revisions | [Self-iteration archive](../archive/self-iteration-progress.md) records DeepSeek 7/7, MiniMax 8/8, dogfood, browser rendering, and foreground shutdown separately. Raw reports under ignored `out/acceptance/` are local and may be absent or overwritten. |
| Trusted Shell Git metadata writes and packaged native runner | Checkpoint recorded on 2026-09-11 | [Implementation archive](../archive/progress-v1.md) and [ADR-0017](../adr/0017-grant-task-owned-git-metadata-writes.md). Preserve the distinction between intended read-only paths and measured profile rule ordering. |
| Earlier macOS/Windows platform and security results | Historical evidence only | [Evidence directory](../evidence/) and [macOS G2 review](macos-g2-review-3408413.md); older Windows passes do not close the current release matrix. |

## Work requiring fresh evidence or a decision

- Run the current candidate through the full required macOS and Windows 11 acceptance matrices, including installed-launcher, TUI, local WebUI, and enabled native capabilities. This cleanup does not perform those runs.
- Continue the Windows credential-isolated Full Access backend using the [Windows checklist](windows-full-access-todo.md) and [Issue #5](https://github.com/sunnynudt/candy/issues/5). Resolve the documented host-local experimental ACL cleanup before a new attempt; never infer Windows approval from macOS.
- Revalidate each enabled provider's required live contracts through [Candy's credential procedure](../testing/live-provider-credentials.md), using the candidate revision and explicit live-test authorization.
- Keep the ADR-0017 profile rule-ordering question visible: moving the read-only rule after workspace grants may change dependency-cache writes. The historical checkpoint did not adopt that policy change.
- Resolve remaining security-review findings and open P0/P1 defects, then obtain the release decision required by the acceptance contract. Historical signing/Desktop work is separate from V1 operator-surface acceptance.
- Reconcile the [unpublished issue drafts](../agents/issue-drafts/README.md) with existing issues and current source before publishing or discarding their remaining requirements.

GitHub issue inventory checked on 2026-09-20: [#2](https://github.com/sunnynudt/candy/issues/2), [#3](https://github.com/sunnynudt/candy/issues/3), [#4](https://github.com/sunnynudt/candy/issues/4), and [#5](https://github.com/sunnynudt/candy/issues/5) were open. This is an inventory, not proof that every old issue description matches the current product contract.

## Documentation maintenance

Update this index with concise changes, exact evidence revisions, and unresolved work. Store sanitized acceptance summaries in `docs/evidence/`. Keep raw logs, sessions, screenshots, machine configuration, and unaccepted personal drafts in ignored local locations.

The [archive](../archive/README.md) preserves superseded progress registers and discussion handoffs for traceability. Do not append new checkpoints there or treat archived instructions as current authority.
