---
"@zhivex-ai/core": patch
"@zhivex-ai/qwen": patch
"@zhivex-ai/sdk": patch
---

Parse standard SSE CR/LF/CRLF framing without corrupting Qwen payloads, discard unfinished EOF frames, and cancel unread transports. Reject Qwen Chat completion without a terminal finish reason. Preserve bounded provider stream diagnostics in durable agent failures without raw SSE data or parser causes.

Use Node/Bun crypto for Qwen Responses attempt IDs so the advertised Node 18 runtime can exercise the corrected stream path without a global Web Crypto flag.
