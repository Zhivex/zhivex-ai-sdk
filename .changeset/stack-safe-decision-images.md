---
"@zhivex-ai/core": patch
---

Validate legacy inline decision image data URLs without a stack-growing base64 regular expression. Large Gemini decision images now reach the native request mapper while preserving MIME, alphabet, padding, and provider input-size restrictions.
