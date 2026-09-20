# Candy documentation

- [Product contract](product/candy-v1.md) and [acceptance standard](product/acceptance-v1.md): current scope and release gates.
- [Implementation status](implementation/self-iteration-progress.md): concise evidence index and unresolved work.
- [Architecture](architecture/), [decisions](adr/), and [technical diagrams](diagrams/README.md): design and decision context. Proposals and superseded decisions are not current implementation claims.
- [Usage](usage/tui-commands.md), [development](development/), and [live-provider testing](testing/live-provider-credentials.md): reusable operating procedures.
- [Evidence](evidence/): sanitized results bound to specific revisions and hosts.
- [Agent guidance](agents/domain.md) and [issue tracker](agents/issue-tracker.md): contributor workflow.
- [Archive](archive/README.md): frozen historical progress and discussion records.

## Local-only material

Downloaded blog pages under `docs/blog_html/`, the specifically ignored research drafts, `docs/diagrams/current-source-2026-08-31/`, `docs/product/candy-current-eli5.html`, and `docs/product/permission-experience-spec.md` are local material excluded by the root `.gitignore`. Do not force-add them. Promote reusable conclusions into reviewed project documentation when appropriate.

Raw test reports belong under ignored `out/`; sessions and credentials belong in Candy-owned application data and approved credential stores. Personal configuration audits, private paths, chat transcripts, and machine-specific screenshots are not public project documentation.

Historical sanitized evidence and ADRs may remain versioned even when old. Replacing a status document does not mean deleting the evidence behind it.
