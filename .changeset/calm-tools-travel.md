---
"@zhivex-ai/qwen": patch
---

Generate non-empty, conversation-durable fallback IDs when Qwen omits tool-call IDs across Chat, Responses, and realtime streams. Preserve later valid IDs, and reject duplicate provider IDs before they enter tool execution or durable agent state.
