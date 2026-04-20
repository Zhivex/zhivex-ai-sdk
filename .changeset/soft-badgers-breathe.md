---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/gemini": minor
"@zhivex-ai/vertex": minor
"@zhivex-ai/openai": patch
"@zhivex-ai/azure-openai": patch
---

Keep OpenTelemetry observability helpers compatible with builds where `@opentelemetry/api` is not installed unless those helpers are used explicitly.

Add shared realtime `sendMedia()` support for image inputs on Gemini, Vertex, Azure OpenAI, and supported OpenAI realtime models, while keeping explicit unsupported errors for unsupported model families or non-image media types.
