---
"@zhivex-ai/qwen": patch
---

Restrict native structured output to Chat Completions. Qwen Responses documents only text output and can return invalid JSON despite a strict json_schema request; reject native schemas with Responses-only features before fetching. Use prompted mode for locally validated structured output with hosted tools.
