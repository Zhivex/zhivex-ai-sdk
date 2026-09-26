---
"@zhivex-ai/qwen": patch
---

Reject invalid Qwen Responses function arguments with sanitized ProviderToolCallError diagnostics. Validate the complete streamed call batch and metadata before exposing executable calls, correlate parallel terminal items by output position, preserve validated terminal usage and cancellation, and classify malformed Responses/Chat SSE separately without retaining sensitive parser causes.
