# Candy current macOS operator-surface evidence package

Status: Partial; this is a sanitized macOS candidate package, not a final V1 release claim.

Generated: 2026-09-08

## Build identity

- Source revision: `34ec232cd45bac6b0ed86d6ac86fd955a31baa53`
- Branch: `codex/candy-v1-foundation`; remote branch resolves to the same revision
- Lockfile SHA-256: `a5d7a3165c2b04551c36a8320fa856c4cf164d08411f6bcf3ef95dc80459f9ba`
- Installation type: source checkout with the pinned Node runtime; no packaged or signed artifact
- Platform: macOS Tahoe `26.6.1` arm64
- Node: `22.23.2`; npm: `10.9.8`; TypeScript: `5.9.3`
- Pi compatibility: `0.84.1`; all seven `@earendil-works/pi-*` packages are pinned to `0.84.1`
- Candy protocol version: `1`; native Sandbox Runner protocol version: `1`
- Candy task metadata schema: `17`
- Electron compatibility line: `43.2.0` (not exercised by this package)

## Reproducible commands and sanitized reports

- `npm run check` — pass, `402/402` tests plus format, lint, typecheck, dependency-boundary, Pi-version, and lifecycle checks.
- `npm run acceptance:macos` — pass, `14/14`; the report records macOS `26.6.1`, arm64, Node `22.23.2`, npm `10.9.8`, and `realPty=true`.
- `npm run smoke:tui:self-development:macos` — pass on this revision through the real DeepSeek Pi Agent Engine: model-stream/tool Esc continuation, same-TUI `/new`, repository understanding, discussion, Task Worktree modification, validator repair, review, restart, and historical task switching.
- Foreground `npm run webui` — current source starts a loopback server, prints a per-process bearer URL, and closes its listener on Ctrl+C; no daemon remains. HTTP authorization and Chrome rendering evidence is recorded in `docs/implementation/self-iteration-progress.md`.

Generated local reports are under the ignored `out/acceptance/` directory:

- `out/acceptance/macos/latest.md`
- `out/acceptance/macos/candy-self-development-latest.md`
- `out/acceptance/tui/darwin-responsiveness-latest.md`

## Acceptance matrix

| Gate | macOS candidate result | Evidence and boundary |
| --- | --- | --- |
| ACC-TUI-01 Installation and stable command | PASS | Pinned toolchain, build, launcher identity, and stable `candy` smoke in `acceptance:macos`. |
| ACC-TUI-02 Credential setup and privacy | PASS | Presence-only credential lifecycle, revocation, session/fixture scans, and credential-free self-development evidence. Live provider reports remain separately tracked. |
| ACC-TUI-03 Core coding journey | PASS | Pi-backed coding journey, review/restart/apply fixture, and real Candy self-development loop. |
| ACC-TUI-04 Lifecycle, control, and recovery | PASS | Esc interruption, explicit continuation, foreground `/new` boundary, restart history, owner fencing, and cancellation tests. |
| ACC-TUI-05 Workspace, tools, and review | PASS | Task Worktree isolation, bounded changes/diff, apply/discard guards, native macOS checks, and current macOS acceptance. Windows-specific containment remains separate. |
| ACC-TUI-06 Candy-owned instructions and resource boundary | PASS | Resource boundary, hostile-resource, diagnostics, redaction, and source-boundary tests in `npm run check`. |
| ACC-TUI-07 Platform and compatibility matrix | NOT_RUN | Windows 11 execution is intentionally deferred to the Windows host. macOS evidence does not substitute for it. |
| ACC-TUI-08 Local responsiveness | PASS (macOS) | Ten-run TUI measurement: cold start p95 `581 ms`, visible projection p95 `10 ms`, cancellation-to-provider-stop p95 `1 ms`, concurrent event gap p95 `0 ms`; all samples passed. |
| ACC-WEB-01 Operator surface and shared state | PASS (macOS) | WebUI contract tests and Chrome task-list, conversation, and bounded change-review rendering evidence. |
| ACC-WEB-02 Boundary and authorization | PASS (macOS) | Loopback binding, bearer authorization, `401` unauthenticated, `403` cross-site, owner fencing, bounded output, and redaction tests. |
| ACC-WEB-03 Lifecycle | PASS (macOS) | Foreground start/stop, owned-task recovery contract, and listener-closed readback; no daemon or post-exit execution claim. |

## Relevant changes and review

The current checkpoint contains only the bounded live-transcript/rendering fix, its regression test, and the PTY acceptance-fixture correction:

- `apps/tui/src/transcript.ts` bounds both live bytes and short segments and caches unchanged assistant Markdown renders.
- `apps/tui/src/transcript.test.ts` covers the many-short-segment regression.
- `tests/smoke-tui-candy-self-development-macos.exp` expands the variable-bearing retry pattern before matching PTY output.

The staged-diff credential scan for the code checkpoint was clean. No provider credential, bearer value, browser authentication data, prompt, raw provider payload, full process environment, unrelated source, or external repository path is included in this package.

## Open boundaries

- Windows 11 platform, native, and full cross-platform acceptance: **NOT_RUN** by explicit scope.
- Final V1 acceptance still requires both target platforms, enabled-provider live evidence at the release candidate, no release-blocking defects, and product-owner approval.
- Electron Desktop and Agent Browser Workspace remain outside this package and are V2 scope.
