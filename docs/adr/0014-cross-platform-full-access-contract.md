---
status: accepted
---

# Use one Full Access contract on macOS and Windows

Candy exposes Full Access as one user-facing, persistent choice on both required host platforms. After the same explicit two-step acknowledgement, an Auto task may use broad local files, local commands, and outbound network access without command-by-command approval; the amber status indication and `/access safe` exit are identical. Full Access never grants Candy provider credentials, bypasses the credential-scanned `candy_git_commit` path, authorizes push without `/push allow`, or permits publishing, release, or deployment.

macOS uses its credential-isolated Seatbelt profile. Windows must use a credential-isolated AppContainer or Win32 App Isolation backend with a stable Candy package identity and the capabilities needed for the confirmed task. A Job Object alone is lifecycle ownership, not a security boundary, and an unsandboxed same-user `CreateProcessW` fallback is prohibited. Windows Full Access remains unavailable until that backend passes the same command, network, credential, cancellation, parent-loss, and publication-negative evidence as macOS; this is an implementation gap, not a different product policy.

## Consequences

- `/access full` is no longer documented or designed as a macOS-only product feature.
- The Windows packaged/identity-backed runner is a V1 TUI requirement, not a Desktop-client feature.
- Full Access may require one OS-level installation or privacy consent, but never routine per-command approval once enabled.
