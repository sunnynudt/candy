# Candy V1 macOS DeepSeek Live Provider Evidence

Status: DeepSeek provider matrix Pass; this is a host-specific evidence record, not a V1 release claim.

Generated: 2026-08-12

## Build identity

- Gate source revision: `7242b74f447f715ab1bd44ea684c63fefd74046b`
- Branch: `codex/candy-v1-foundation`
- Platform: macOS `26.5.2` arm64
- Node: `22.23.2`
- npm: `10.9.8`
- Approved Provider: `deepseek`
- Approved host: `https://api.deepseek.com`
- Candy credential path: OS Keychain account `candy-v1/deepseek`; only presence is retained in evidence

The worktree was clean and the branch matched `origin/codex/candy-v1-foundation` before the run. The Gate invocation explicitly removed `CANDY_DEEPSEEK_API_KEY`, `CANDY_MINIMAX_TOKEN_PLAN_KEY`, `DEEPSEEK_API_KEY`, and `MINIMAX_CN_API_KEY`, so the live run used Candy's Keychain path. No other tool configuration was read or imported, and the MiniMax Gate was not run.

## Commands and sanitized result

- `npm run build` — pass.
- `npm run gate:live:deepseek` — exit code `0`.
- `npm run check` — pass; `109/109` tests.
- Local sanitized report: `out/acceptance/live/deepseek-latest.md` (gitignored).

| Test | Status | Duration | Sanitized summary |
| --- | --- | ---: | --- |
| `LIVE-DS-01` | pass | 1462 ms | live Flash text turn completed with streamed assistant events |
| `LIVE-DS-02` | pass | 1579 ms | live Flash thinking/tool turn completed |
| `LIVE-DS-03` | pass | 4029 ms | live Pro thinking/tool turn completed |
| `LIVE-DS-04-cancel` | pass | 260 ms | live turn cancelled; no completion event |
| `LIVE-DS-04-error-contracts` | pass | 3 ms | controlled 401/429/timeout classifications passed; recovery verified |
| `secret-free-session` | pass | 0 ms | session and fixture scan |
| `secret-lease-release` | pass | 0 ms | provider lease lifecycle |

## Credential and acceptance boundary

- The report contains no credential value, length, fingerprint, authorization header, prompt, or raw Provider payload.
- The session/fixture scan found no credential value, and the provider lease release assertion passed.
- The controlled 401/429/timeout row is an in-process contract fixture; it is not described as a real Provider limit event.
- This evidence closes the macOS DeepSeek provider matrix together with the separately recorded Windows host result. It does not close MiniMax Token Plan evidence, signed/notarized packaging, G2 security review, Browser/ACC evidence, Windows release parity, or final V1 acceptance.
