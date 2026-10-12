# Candy implementation status and evidence index

Updated: 2026-09-20 (documentation cleanup and workspace test layout; no new acceptance run)

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

## CI repair follow-up (2026-10-09)

The `fix/ci-platform-tests` working tree is based on main `33c456a`.
The local-command readiness test now checks the real host gate rather than
assuming a fake runner enables it. The production containment gate is unchanged.
The composition-root fixture now waits for TUI shutdown even on assertion failure
before deleting its temporary Git directory. Two macOS-only fixtures explicitly
report skips on unsupported hosts, and the native npm fixture fails rather than
silently passing when its required runner is missing.

CI builds the locked native runner with Rust 1.97.1 before tests and Windows
native smoke. The integration-branch instructions now reflect the V1 integration
through PR #6 and subsequent work on main-based branches.

Linux validation: `npm run check` passed, with 494 tests passed, two macOS-only
fixtures explicitly skipped, and zero failures. TUI, task, app-server and actual
WebUI process smoke checks passed using the configured writable Candy data
directory. The historical
macOS offline npm failure still requires reproduction and native command output
on an accepted macOS arm64 host; adding diagnostics does not establish its fix.
The historical ENOTEMPTY failure also requires macOS rerun to verify the cleanup
correction. No new GitHub Actions, macOS, Windows or live-provider acceptance is
claimed by this local change.

## Documentation maintenance

Workspace test layout maintenance (2026-09-20): moved 35 unit-test files from
`src/` into workspace-local `tests/` directories: 21 across Pi Adapter, Platform,
Protocol, and Runtime, plus 14 across App Server, Desktop, and TUI.
Separate test projects emit into ignored `build/`
directories; product entry points remain in `dist/`. The unit-test runner maps
current test sources to compiled outputs so stale artifacts cannot duplicate
tests. See [test layout](../../tests/README.md). This is a structural change, not
new platform or provider acceptance evidence.

Validation on the `chore/separate-package-tests` working tree based on `11c46fa`:
clean TypeScript build, formatting, lint, dependency boundaries, Pi version graph,
and lifecycle-script checks passed; the four packages passed 292/292 tests.
The initial package-only migration run was PARTIAL (495/496 passed): the unchanged TUI test
`default TUI runs an offline npm script in its Task Worktree without a local approval`
failed because its local command reported failure. The same test failed in
isolation; its underlying cause remains unresolved. No Windows or live-provider
acceptance was run for this layout change.

After migrating application tests, a clean rebuild and the same static checks
passed. All 35 current test files have compiled outputs, with no test files left
in `src/` or compiled tests in `dist/`. The full run was PARTIAL (494/496 passed):
the offline npm test still failed, and
`default TUI composition root isolates new Auto tasks with local commands ready`
failed during temporary Git-directory cleanup with `ENOTEMPTY`. Test assertions
and product implementation were unchanged by either migration. The cleanup test
passed when run alone; this does not convert the full-run failure into a pass.

Update this index with concise changes, exact evidence revisions, and unresolved work. Store sanitized acceptance summaries in `docs/evidence/`. Keep raw logs, sessions, screenshots, machine configuration, and unaccepted personal drafts in ignored local locations.

The [archive](../archive/README.md) preserves superseded progress registers and discussion handoffs for traceability. Do not append new checkpoints there or treat archived instructions as current authority.
