---
status: accepted
---

# Use explicit Browser takeover when automatic detection is unreliable

Candy first attempts to return Browser Control to the user automatically when physical interaction interrupts an agent action. Electron does not guarantee a reliable distinction between every physical input event and CDP-synthesized input, so V1 falls back to a visible Take Control action when the packaged Browser cannot prove that distinction; this preserves deterministic single-owner control instead of guessing who acted.

## Consequences

Take Control immediately cancels the conflicting agent action and transfers the tab to the user. The agent cannot silently retake control; a later user-visible command or release is required. Product UI and documentation must show when explicit takeover is active rather than claiming automatic takeover.
