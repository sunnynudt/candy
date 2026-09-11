# Candy evidence records

This directory holds sanitized acceptance and checkpoint records. Each record
describes the exact source revision, host, and scope it was produced on; it is
evidence for that scope only and never a general release claim.

Scope note: the current product contract is `docs/product/candy-v1.md` and the
current acceptance contract is `docs/product/acceptance-v1.md`, whose gates are
`ACC-TUI-*` and `ACC-WEB-*`. Electron Desktop and the Browser Workspace are V2
there. Records below that use the older `ACC-01`…`ACC-12` gate names, or that
treat Desktop or Browser as V1 gates, predate that contract and must be read as
historical scope, not as missing V1 work. No result recorded in an older package
is changed or withdrawn by this note.

| Record                                    | Generated  | Scope                                                                     | Recorded status                          |
| ----------------------------------------- | ---------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| `acceptance-v1-macos-34ec232.md`          | 2026-09-08 | Current macOS operator surface, revision `34ec232`                        | Partial: ACC-TUI/ACC-WEB pass on macOS; Windows and final V1 approval open |
| `issue-2-windows-native-sandbox-2026-08-14.md` | 2026-08-14 | Windows native sandbox (Issue #2) implementation                      | Blocked: Trusted Shell Auto stays disabled |
| `windows-personal-preview-2026-08-13.md`  | 2026-08-13 | Windows Personal Preview Shell slice                                      | Implementation checkpoint, unsigned preview |
| `acceptance-v1-windows-8c6b006.md`        | 2026-08-12 | Windows 11 Pro x64 acceptance, revision `8c6b006`                         | Blocked (historical `ACC-01`…`ACC-12`)   |
| `acceptance-v1-windows-b7cab12.md`        | 2026-08-12 | Windows 11 Pro x64 acceptance, revision `b7cab12`                         | Blocked (historical `ACC-01`…`ACC-12`)   |
| `acceptance-v1-macos-deepseek-20260812.md` | 2026-08-12 | macOS DeepSeek live-provider matrix, revision `7242b74`                  | Provider matrix pass (host-specific)     |
| `acceptance-v1-local-0710d00.md`          | 2026-08-10 | Local deterministic review, revision `0710d00`                            | Blocked (historical `ACC-01`…`ACC-12`)   |

Open release gates that none of these records close are tracked in
`docs/implementation/blockers-v1.md`: signed/notarized packaging on both
platforms, Windows OS-level arbitrary-command containment, an independent
security review, and product-owner approval.
