---
status: superseded by ADR-0003
---

# Keep DeepSeek primary and use MiniMax only for vision

Candy V1 uses DeepSeek as its only Primary Model and MiniMax domestic Token Plan as a separate Vision Provider. MiniMax interprets pasted images and browser screenshots, then returns a structured result for DeepSeek to use; it does not control tools, files, or the agent loop. This preserves a DeepSeek-first product while supporting UI designs, charts, and ordinary images that DeepSeek's text API cannot inspect.

This decision was superseded after Candy adopted MiniMax M3 as a selectable native multimodal Primary Model in V1.

## Consequences

MiniMax traffic is restricted to `https://api.minimaxi.com` with no global-site fallback. Candy does not include local OCR in V1: if visual analysis fails, it reports the failure and offers retry or cancel rather than presenting partial text extraction as image understanding.
