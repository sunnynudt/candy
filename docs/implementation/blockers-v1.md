# Candy V1 Blocker Register

Updated: 2026-08-09

| ID | Owner | Status | Blocks | Validation procedure |
| --- | --- | --- | --- | --- |
| G0-LIVE-DS | Product owner + implementation agent | Blocked | Enabling DeepSeek labels and ACC-04 live evidence | Run LIVE-DS-01 through LIVE-DS-04 with an approved test credential under `docs/testing/live-provider-credentials.md`. |
| G0-LIVE-MM | Product owner + implementation agent | Blocked | Enabling MiniMax M3 and ACC-04 live evidence | Confirm Token Plan entitlement and run LIVE-MM-01 through LIVE-MM-05 against `api.minimaxi.com`. |
| G0-MAC | Product owner | Blocked | macOS claims and final cross-platform acceptance | Run the required matrix on macOS Sequoia 15+ Apple Silicon and attach sanitized evidence. |
| G1-PERSISTENCE | Implementation agent | In progress | Final selection of `node:sqlite` topology | Pass import, concurrency, WAL recovery, migration, and packaged app-server tests. |
| G2-SANDBOX | Implementation agent + security reviewer | In progress | Shell-enabled Auto and Shell Auto Debug | Specify the v1 protocol, implement both native backends, and pass escape, no-network, descendant, cancellation, packaging, and security-review tests. |
| G3-BROWSER | Implementation agent | Pending | Automatic Browser takeover claim | Test packaged Electron input-origin behavior; use explicit Take Control if origin cannot be distinguished reliably. |
| SIGNING | Product owner | Blocked | Signed/notarized release evidence | Provide Windows signing and Apple signing/notarization identities only through approved platform tooling. |

Blocked external resources do not stop independent implementation. They do prevent the affected capability or release claim from being marked Pass.
