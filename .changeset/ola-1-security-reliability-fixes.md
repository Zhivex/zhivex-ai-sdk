---
"@zhivex-ai/ag-ui": patch
"@zhivex-ai/anthropic": patch
"@zhivex-ai/azure-openai": patch
"@zhivex-ai/bedrock": patch
"@zhivex-ai/core": patch
"@zhivex-ai/deepseek": patch
"@zhivex-ai/gateway": patch
"@zhivex-ai/gemini": patch
"@zhivex-ai/kimi": patch
"@zhivex-ai/meta": patch
"@zhivex-ai/ollama": patch
"@zhivex-ai/openai": patch
"@zhivex-ai/qwen": patch
"@zhivex-ai/sandbox-docker": patch
"@zhivex-ai/trace-viewer": patch
"@zhivex-ai/xai": patch
---

Harden gateway budget failure isolation, sandbox-docker archive/proxy/stream safety, trace-viewer loopback Host validation and CLI symlink invocation, ag-ui approval/stream bounds, provider SSE error/truncation handling, credentialed redirect checks, HTTP retry enforcement, and timeout cleanup.

Honor the configured error-body byte limit on each Qwen transcription and speech generation attempt.
