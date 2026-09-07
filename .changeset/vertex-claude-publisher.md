---
"@zhivex-ai/anthropic": minor
"@zhivex-ai/vertex": minor
"@zhivex-ai/sdk": patch
---

Support Claude on Vertex with Google bearer authentication, Anthropic publisher routing, text, client tools, streaming, reasoning, and native structured output on supported models. Reuse Anthropic message mapping through an explicit host transport factory and reject direct-API-only features.

Keep the Vertex package, factory, and provider identity. Add validated explicit publisher resources to raw prediction, limit raw prediction capabilities to their actual contract, and correct Model Garden coverage documentation. Add separate Vertex Claude catalog entries without inheriting direct Anthropic pricing or recommendations.
