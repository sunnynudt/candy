# Candy V1 Technical Diagrams

These diagrams are generated from the JSON sources in [`source/`](./source/) with Archify. Every HTML artifact supports light/dark themes and PNG, JPEG, WebP, and SVG export.

- [System architecture](./candy-system-architecture.html) — processes, local data, browser, and model providers.
- [Runtime deep modules](./candy-runtime-modules.html) — module interfaces and internal seams.
- [Task turn sequence](./candy-task-turn-sequence.html) — model, tool, approval, browser, and persistence interactions.
- [Auto Debug workflow](./candy-auto-debug-workflow.html) — reproduce, repair, rerun, verify, and pause paths.
- [Task lifecycle](./candy-task-lifecycle.html) — queueing, execution, approvals, pause/resume, recovery, and terminal states.

Regenerate one diagram from the Archify skill directory:

```text
node bin/archify.mjs render <type> <absolute-json-path> <absolute-html-path>
node bin/archify.mjs validate <type> <absolute-json-path> --json
node bin/archify.mjs check <absolute-html-path>
```
