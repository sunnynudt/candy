# Candy V1 Blocker Register

Updated: 2026-08-10

| ID             | Owner                                    | Status      | Blocks                                                     | Validation procedure                                                                                                                                  |
| -------------- | ---------------------------------------- | ----------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0-LIVE-DS     | Product owner + implementation agent     | Blocked     | Enabling DeepSeek labels and ACC-04 live evidence          | Run LIVE-DS-01 through LIVE-DS-04 with an approved test credential under `docs/testing/live-provider-credentials.md`.                                 |
| G0-LIVE-MM     | Product owner + implementation agent     | Blocked     | Enabling MiniMax M3 and ACC-04 live evidence               | Confirm Token Plan entitlement and run LIVE-MM-01 through LIVE-MM-05 against `api.minimaxi.com`.                                                      |
| G0-MAC         | Product owner                            | Blocked     | macOS claims and final cross-platform acceptance           | Run the required matrix on macOS Sequoia 15+ Apple Silicon and attach sanitized evidence.                                                             |
| G1-PERSISTENCE | Implementation agent                     | In progress | Final selection of `node:sqlite` topology                  | Pass import, concurrency, WAL recovery, migration, and packaged app-server tests.                                                                     |
| G2-SANDBOX     | Implementation agent + security reviewer | In progress | Shell-enabled Auto and Shell Auto Debug                    | Specify the v1 protocol, implement both native backends, and pass escape, no-network, descendant, cancellation, packaging, and security-review tests. |
| G3-BROWSER     | Implementation agent                     | Pending     | Automatic Browser takeover claim                           | Test packaged Electron input-origin behavior; use explicit Take Control if origin cannot be distinguished reliably.                                   |
| SIGNING        | Product owner                            | Blocked     | Signed/notarized release evidence                          | Provide Windows signing and Apple signing/notarization identities only through approved platform tooling.                                             |
| G0-DS-ADAPTER  | Implementation agent                     | Blocked     | Enabling DeepSeek V4 Flash/Pro and ACC-03/04 live evidence | Run the approved Pi-backed live matrix with an approved credential; this unattended run will not inspect or import credentials from another tool.     |
| G0-MAC-RUNTIME | Product owner                            | Blocked     | Runtime cross-platform claim                               | Run the Runtime proof and session-remap matrix on macOS Sequoia 15+ Apple Silicon.                                                                    |

## 2026-08-10 Phase 2 checkpoint

- Q1 Pi public surface: Pass for the deterministic adapter seam. `@earendil-works/pi-coding-agent` root exports and documented `SessionManager` are used; no internal Pi import is used by Candy source.
- Q2 DeepSeek contract: Pass for the deterministic contract seam only. The approved domestic DeepSeek endpoint, request shape, SSE parser, abort signal, tool-capable request field, and lease release are covered by fixtures. Live provider behavior remains Blocked under G0-LIVE-DS and G0-DS-ADAPTER.
- Q3 Candy-owned session: Pass locally. `CandyPiSessionStore` stores under the injected Candy app-data root, persists through Pi's `SessionManager`, and reloads with a remapped cwd.
- Q4 forbidden sinks: Pass for deterministic coverage. Protocol/session fixtures reject secret-shaped values; the provider lease is released before response consumption and is not projected into Runtime observations. No credential was read or requested.
- Q5 two-platform fixture: Blocked for macOS evidence. Windows local deterministic checks pass; macOS Sequoia execution and live provider evidence are unavailable in this unattended environment.

Blocked external resources do not stop independent implementation. They do prevent the affected capability or release claim from being marked Pass.
