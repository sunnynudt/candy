# Windows Full Access continuation checklist

Status: paused and fail-closed on 2026-08-31.

Tracking issue: [#5](https://github.com/sunnynudt/candy/issues/5).

Windows does not currently expose `/access full`. The TUI has a
host-bound Windows gate, but its source attestation remains `approved: false`.
The native runner rejects a Windows `fullAccess` request rather than falling
back to an unsandboxed same-user process. This preserves the shared Full
Access contract in ADR-0014 while the Windows backend remains incomplete.

## Evidence from the paused investigation

- A stable Windows Sandbox Engine/AppContainer identity can start a child on
  this Windows 11 host.
- The attempted Bound File System grant did **not** permit the child to write
  an allowed outside-workspace fixture. It is therefore not an acceptable
  Full Access backend and has not been enabled.
- The exploratory Windows smoke command was deliberately removed from the
  package scripts: a named smoke test must be passing evidence, never a known
  failure in the normal developer interface.
- One temporary ACL grant from the early desktop-AppContainer experiment must
  be removed and verified on the host before the next attempt. Do not reset or
  broadly rewrite the user profile ACL; remove only the known test principal's
  ACE after resolving it again.

## Resume in this order

1. Clean up the temporary test AppContainer profile/ACL and verify that no
   Candy sandbox child from the experiment remains alive.
2. Establish which documented Windows 11 backend is actually usable on the
   acceptance host: Windows Sandbox Engine with Bound File System, packaged
   AppContainer/Win32 App Isolation, or another credential-isolated backend.
   Record the required OS build, installation identity, and capability
   availability. Do not enable a fallback that merely uses a Job Object or an
   ordinary same-user process.
3. Implement one stable Candy identity and its explicit filesystem/network
   policy. Keep provider credentials out of the child environment and out of
   the platform credential-store boundary; do not create persistent broad ACL
   grants on the user profile as a substitute for the backend policy.
4. Add a passing, Windows-only smoke matrix covering:
   - Full Access write outside the workspace within the approved broad scope;
   - outbound and private-network connectivity;
   - active provider-secret absence and credential-store denial;
   - cancellation and parent-loss descendant cleanup;
   - commit, push, publish, release, and deploy negative controls.
5. Run the matrix on the required Windows 11 host, then change the immutable
   Windows attestation to approved. Only then enable `/access full` →
   `/access full confirm`, persistence, and the `⚠ FULL ACCESS` TUI badge on
   Windows.

The macOS Full Access path remains unchanged. Windows evidence must be
collected independently and must not be inferred from macOS results.
