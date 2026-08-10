# Live Provider Credential Procedure

Status: required for provider Gate tests

This procedure defines how Candy development and acceptance tests receive real DeepSeek and MiniMax credentials without making another tool's configuration a Candy credential source or leaking a token into the repository, command line, logs, sessions, diagnostics, evidence, or child processes.

## Local configuration audit result

A redacted local audit on 2026-08-09 established only the following facts:

- an existing Claude Code configuration selects the domestic MiniMax Anthropic-compatible endpoint and MiniMax M3, and a credential is present;
- local Claude Code usage metadata contains entries for DeepSeek V4 Flash, DeepSeek V4 Pro, and MiniMax M3;
- an existing OpenCode authentication store contains a DeepSeek API credential entry;
- the user reports these provider configurations are currently usable.

No credential value, credential fragment, reversible fingerprint, complete configuration, external local path, or unrelated project data was copied into Candy or this document. These facts show that suitable accounts likely exist; they do not close Candy's live Pi/Provider contract tests.

## What Candy may and may not do

Candy may:

- accept a credential through a temporary provider-specific environment variable owned by the trusted test/runtime process;
- accept a credential explicitly entered by the user into Candy and stored through the OS credential-store Adapter;
- inspect another tool's configuration only through a redacted, user-authorized audit that reports provider/model/endpoint and credential presence.

Candy must not:

- automatically read Claude Code, OpenCode, Codex, shell-profile, or editor credential files at runtime;
- copy or migrate a credential from another tool without a new explicit product and security decision;
- ask the user to paste a token into chat, an issue, a Markdown file, a test fixture, a command argument, or a repository `.env` file;
- print credential values, prefixes, suffixes, lengths, hashes, headers, process environments, or source configuration contents;
- pass a provider credential to the Sandbox Runner, tool process, Browser, renderer, JSONL protocol, or acceptance evidence writer.

Existing Claude Code/OpenCode configuration is therefore discovery evidence only, not an approved Candy credential source.

## Credential identifiers

Development Gate runners and Candy use Candy-owned variable names:

| Provider | Temporary process variable | Credential-store account | Approved host |
| --- | --- | --- | --- |
| DeepSeek | `CANDY_DEEPSEEK_API_KEY` | `deepseek` | `https://api.deepseek.com` |
| MiniMax Token Plan | `CANDY_MINIMAX_TOKEN_PLAN_KEY` | `minimax-token-plan` | `https://api.minimaxi.com` |

The MiniMax Token Plan subscription Key and a metered MiniMax API Key are different credential types and must not share an account identifier or be silently substituted.

## Development workflow before Candy Settings exists

1. The developer opens a private local terminal and enters the credential through a non-echoing secret prompt or approved local secret manager. The token must not appear in shell history or the command line.
2. The credential is placed only in the environment of the trusted live-test process using the Candy-owned variable above.
3. The Gate runner reports only `present`, provider, model, approved host, test ID, status, timing, response schema summary, usage summary where allowed, and sanitized error code.
4. The test runs in a Candy-owned fixture repository. Tool subprocess environments are built from an allowlist and assert that both Candy provider variables are absent.
5. The runner removes the temporary variable on exit, including failure and cancellation paths. The developer closes the private terminal after the run.
6. A repository, task-data, session, log, diagnostic, crash, and evidence scan must find no credential material before the Gate can pass.

The default test command never runs live provider tests. Live tests require a separate explicit provider-specific command and an opt-in flag so an untrusted test or pull request cannot spend quota or contact a provider.

The repository provides two explicit Gate commands after the pinned build is ready:

```zsh
npm run build
npm run gate:live:deepseek
npm run gate:live:minimax
```

Run only the provider command whose Candy-owned environment variable was placed in the private trusted process. The runner requires `--confirm-live` internally, removes both Candy provider variables from its process environment before creating the Pi engine, uses a temporary fixture/session directory outside the repository, and writes only sanitized results to `out/acceptance/live/`. Missing credentials produce `Blocked` without a network request. The runner also keeps controlled error fixtures, entitlement-console confirmation, and any unavailable thinking/tool proof as `Blocked`; a successful HTTP turn alone is not a Gate pass.

## Product workflow after the credential store exists

1. The user enters the credential in Candy Settings or the TUI's trusted credential prompt.
2. Desktop main or the trusted TUI path writes it through the OS credential-store Adapter and returns presence only.
3. The Provider path obtains a short-lived secret lease immediately before the approved HTTPS request.
4. The credential is never returned to the renderer or Runtime command/event protocol.
5. Replace and delete operations are explicit. Deletion is verified by the next call returning `needs_credentials`.

There is no automatic import from Claude Code or OpenCode in V1. A future migration feature would require a separate ADR, a one-time local consent flow, source-specific security review, and proof that no credential reaches logs or general tool processes.

## Mandatory live matrix

The following tests from [Compatibility Gate 0](../research/compatibility-gate-0.md) must pass:

- DeepSeek: `LIVE-DS-01` through `LIVE-DS-04`;
- MiniMax: `LIVE-MM-01` through `LIVE-MM-05`;
- Pi/package/platform: `LIVE-PI-01`, `LIVE-PI-02`, and `LIVE-ELECTRON-01` where applicable.

For the user's existing accounts, MiniMax verification must confirm that the current Token Plan subscription Key can access `MiniMax-M3` and that the control-panel deduction matches the call. DeepSeek verification must prove both Flash and Pro are visible and support the required streaming, thinking/tool replay, cancellation, and sanitized error behavior.

## Evidence retention

Allowed evidence:

- provider and official model identifier;
- approved hostname and API family, without query strings or headers;
- timestamp, duration, status code/error class, stream event types, usage totals where provider terms permit, and assertion results;
- exact Candy/Pi/runtime versions and fixture revision.

Forbidden evidence:

- Authorization headers or request dumps containing them;
- environment dumps;
- complete source configurations from other tools;
- credentials, fragments, lengths, hashes, or fingerprints;
- raw provider payloads containing private prompts, source, browser data, or model reasoning not needed for the assertion.

Live evidence stays local in Candy's acceptance-results area and is excluded from ordinary source control unless a sanitized review explicitly confirms that it contains no secret or private data.
