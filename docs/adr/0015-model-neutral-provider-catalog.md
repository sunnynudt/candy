---
status: accepted
---

# Use a model-neutral provider catalog with capability-declared attachments

Candy is model-neutral at the product boundary. Built-in and user-configured models are ordinary selectable models that may control reasoning, coding, and tools. MiniMax M3 is a normal model on the domestic `minimax-cn` provider path; it is not a vision provider, image helper, or special image-processing route. Candy must not silently hand a task from one model to another.

Image attachments are governed by the selected model's declared input capability. A model that does not declare image input receives no image attachment, and the user receives an actionable model-capability message. Adding an image-capable model requires the same provider and platform evidence as any other enabled model; it does not create a provider-wide image role.

## Consequences

- Model selection, task persistence, provider routing, and live gates describe MiniMax as an ordinary model.
- MiniMax live acceptance covers its ordinary text, tool, thinking, cancellation, and error behavior; a MiniMax-specific image scenario is not a release requirement.
- Existing image attachment storage and UI remain capability-gated, but their guidance is generic and may target only a model that declares image input.
- The domestic MiniMax endpoint and credential isolation remain unchanged. Removing the special image role does not permit global fallback or credential widening.
- ADR-0003 and the DeepSeek-first portfolio terminology are historical and superseded.
