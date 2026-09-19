---
"@zhivex-ai/qwen": patch
---

Preserve complete Chat tool calls when named tool selection ends with `stop`. Validate the entire buffered batch before emission, reject incomplete or invalid calls and late explicit provider errors, and retain reported usage on typed failures. Require Core 1.22.0 for failure usage accounting.
