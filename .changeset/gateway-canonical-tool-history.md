---
"@zhivex-ai/gateway": minor
---

Accept canonical core ModelMessage history alongside legacy gateway messages. Validate tool call/result associations and JSON payloads before routing, preserve native Anthropic tool and error blocks, and explicitly skip incompatible destinations. Continue generation, object output and streams without reexecuting resolved historical tools, and sanitize history failure/cancellation diagnostics without restarting after partial output. Agent operations retain legacy-only input.
