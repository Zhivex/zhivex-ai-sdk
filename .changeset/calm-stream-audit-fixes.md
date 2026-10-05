---
"@zhivex-ai/core": patch
"@zhivex-ai/sdk": patch
---

Fix streaming backpressure and cancellation, emit structured object completion only after final validation, preserve nested input identity in generate caches, count streamed error events in circuit breakers, and stop parallel workflows promptly when failFast is enabled. Add cooperative cancel hooks to generated text/object stream results and onCancel hooks to SSE/UI response adapters.
