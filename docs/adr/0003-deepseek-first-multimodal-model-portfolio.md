---
status: accepted
---

# Use a DeepSeek-first model portfolio with MiniMax M3 multimodal

Candy V1 supports DeepSeek V4 Flash, DeepSeek V4 Pro, and MiniMax M3 as selectable Primary Models, with DeepSeek V4 Flash as the default. MiniMax M3 receives text and image attachments natively and may control the normal agent loop; Candy does not reduce it to a secondary vision service or silently route a DeepSeek turn through MiniMax. This keeps Candy DeepSeek-first while making native multimodal coding a V1 capability.

## Consequences

Each task has one Primary Model and may switch models only between turns. Provider failures are explicit and never trigger silent cross-provider fallback. Every MiniMax request, credential, and multimodal attachment is restricted to `https://api.minimaxi.com`, and video input remains gated until the domestic API contract and Token Plan behavior are verified.
