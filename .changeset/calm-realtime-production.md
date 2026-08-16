---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/agents": minor
"@zhivex-ai/azure-openai": patch
"@zhivex-ai/gemini": patch
"@zhivex-ai/qwen": patch
"@zhivex-ai/vertex": patch
---

Promote the shared realtime and live-agent contract to Stable. Harden session
lifecycle, browser transport and frame encoding, tool-call deduplication,
post-tool continuation, cancellation, durable idempotency, memory context, and
fail-closed approvals. Correct provider capability claims and Google/Qwen Live
protocol handling, and add deterministic installed-package plus live
Gemini/Qwen/OpenAI certification gates.
