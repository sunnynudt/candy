# macOS Trusted Shell Auto — G2 Review Package

Date: 2026-08-18
Branch: `codex/candy-v1-foundation`
Review target: `3408413e001fcd83d32211a8ceed86ccf8149bf4` (with security checkpoint `9009ac1` and anchor-root follow-up `3408413`)
Host evidence: macOS Tahoe `26.6.1` arm64, Node `v22.23.2`, npm `10.9.8`

## Purpose

This package lets an independent reviewer (or the product owner) decide the macOS G2 gate for Trusted Shell Auto. It records what the security hardening changed, why it is intended to close the four medium findings from scan `721c4ab5-ccdf-4052-9a28-b695323b3b70`, which regressions cover each route, and what remains to be done after approval. The production capability remains fail-closed until that decision is recorded: `MACOS_TRUSTED_SHELL_AUTO_G2_ATTESTATION.approved` is still `false` in `apps/tui/src/main.ts:150`.

## Finding closure matrix

| Finding (scan `721c4ab5`) | Mitigation | Code location | Regression coverage |
| --- | --- | --- | --- |
| Git worktree path-check/use race | Every existing component from the Candy worktree root to the target is bound with no-follow directory handles; the root itself is bound first; identity (dev+ino) is revalidated around each Git operation. Same-path directory replacement or symlink swap fails closed. `nativeGitPathSeam.canonicalize` resolves the longest existing prefix so pre-create checks do not mix `/var` and `/private/var` aliases. | `packages/runtime/src/v1.ts`: `bindWorktreePathComponents` (~1228), `assertWorktreePathComponentsUnchanged` (~1290), `nativeGitPathSeam.canonicalize` (~805), `GitWorktreeManager` (~1296) | `packages/runtime/src/v1.test.ts:809` (same-path parent replacement during create), `:840` (same-path worktree replacement during inspect), `:721` (`/var` vs `/private/var`) |
| Workspace intermediate-component race | Workspace read/write/mkdir/access/delete hold a directory-handle chain from the selected workspace root (now including the root anchor itself) to the target parent, then revalidate identities before and after the operation. Root replacement or parent replacement fails closed, including during delete approval. | `packages/pi-adapter/src/index.ts`: `openWorkspaceDirectoryChain` (~2097), `assertWorkspaceRootBinding` (~2209), `sameDirectoryIdentity` (~2078) | `packages/pi-adapter/src/pi-adapter.test.ts:1535` (parent replacement during delete approval), `:1570` (workspace-root replacement during delete approval), `:1502` (symlinked selected root) |
| Residual Pi session-manager path race | Session directories use the same handle-chain binding with the Candy session root as the anchor; Pi `SessionManager.create/open/listAll` are revalidated before and after. Relative session files resolve against the Candy session root instead of the process cwd. | `packages/pi-adapter/src/index.ts`: `openSessionDirectoryChain` (~2384), `bindSessionDirectory` (~2495) | `packages/pi-adapter/src/pi-adapter.test.ts:2323` (relative session-file reload inside the session root), `:2282` (symlinked task directory), `:2267` (traversal task ids) |
| Conditional Trusted Shell descendant-publication risk | `candy_bash_network` no longer runs a shell: it parses the approved command into a direct read-only tool invocation (`git ls-remote`, `curl` GET/HEAD, `wget` GET), passes `allowProcessExec: false`, and therefore cannot create publication-capable descendants. `containsShellPublicationAction` rejects nested interpreters/executors (`sh -c`, `python3 -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`, `env`, `xargs`, `find -exec`, `make`, `npm run`, `npx`, `sudo`, `su`, `ssh`, `docker`, `awk system(...)`) before approval or spawn. | `packages/pi-adapter/src/index.ts`: `containsShellPublicationAction` (~539), `candy_bash_network` tool (~1148), network spawn with `allowProcessExec: false` (~1236) | `packages/pi-adapter/src/pi-adapter.test.ts:1840` (publication commands rejected), `:1946` (nested-interpreter/descendant forms rejected), `:2016` (network tool restricted to read-only direct tools with `allowProcessExec: false`) |

## Verification evidence on the review target

| Gate | Result | Report binding |
| --- | --- | --- |
| `npm run check` | 248/248 (241 baseline + 7 new security regressions) | Embedded in acceptance report below |
| `npm run check:native` | Pass | `out/acceptance/macos/latest.md` |
| `npm run smoke:sandbox:macos` | Pass, strict containment matrix | `out/acceptance/macos/latest.md` |
| `npm run acceptance:macos` | 14/14, `realPty=true`, real-PTY terminal matrix passes | `out/acceptance/macos/latest.md`, source revision `3408413e001fcd83d32211a8ceed86ccf8149bf4` |
| Live DeepSeek gate | 7/7 (historical source `a523aa2`; current-HEAD rerun pending user authorization) | `out/acceptance/live/deepseek-latest.md` |
| Live MiniMax gate | 8/8 (historical source `a523aa2`; current-HEAD rerun pending user authorization) | `out/acceptance/live/minimax-cn-latest.md` |
| Independent standard scan rerun | Not available in this session; scan `721c4ab5` remains the last external scan | Pending |

The staged diff for each checkpoint was scanned for credential-shaped material before commit. Push to `origin/codex/candy-v1-foundation` was verified: local and remote SHAs match for `3408413`.

## Reviewer checklist

1. Confirm each mitigation above closes the corresponding race/publication route rather than only reducing its likelihood.
2. Confirm the no-follow directory-handle chains include the anchor roots and intermediate components, and that identity mismatch fails closed before any side effect.
3. Confirm the network tool cannot invoke an interpreter or executor and passes `allowProcessExec: false`.
4. Confirm the normal TUI composition root remains fail-closed (`apps/tui/src/main.ts:150`, `approved: false`) and that no environment variable or user-controlled option can enable it.
5. Confirm the checkpoint scope is macOS security hardening only; Windows execution is deferred for this work packet and no Windows claim is made.
6. Confirm no provider credential is written to sessions, logs, tool arguments, or subprocess environments in the changed code.

## Decision

- Approve macOS G2 and flip `MACOS_TRUSTED_SHELL_AUTO_G2_ATTESTATION.approved` to `true`, then run `smoke:tui:trusted-shell:macos` attempts 1–3, `smoke:tui:trusted-shell:dogfood:macos`, the real-PTY terminal matrix, and three real DeepSeek Trusted Shell coding journeys with cancellation/approval/restart/Apply checks.
- Or reject / request changes: the gate stays `false` and Trusted Shell remains unavailable.

### Sign-off

Reviewer / product owner: ________________________
Date: ________________________
Decision (approve / reject): ________________________
Notes: ________________________
