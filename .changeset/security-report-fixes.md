---
"@zhivex-ai/bedrock": patch
"@zhivex-ai/core": patch
"@zhivex-ai/deepseek": patch
"@zhivex-ai/gateway": patch
"@zhivex-ai/gemini": patch
"@zhivex-ai/kimi": patch
"@zhivex-ai/meta": patch
"@zhivex-ai/openai": patch
"@zhivex-ai/openrouter": patch
"@zhivex-ai/qwen": patch
"@zhivex-ai/sdk": patch
"@zhivex-ai/vertex": patch
"@zhivex-ai/zai": patch
---

Gateway deployments authorize the registered region and endpoint. Credentialed provider fetches reject redirects. Gemini and DeepSeek file uploads reject bodies over 64 MiB before they are read. Meta streams cap tool-call state. The A2A server authenticates a JSON-RPC request before reading its body.
