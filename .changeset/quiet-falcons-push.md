---
"@zhivex-ai/qwen": patch
"@zhivex-ai/kimi": patch
---

Align the advertised capability contract with the current runtime behavior.

- mark the common `reasoning` capability as unsupported for Qwen and Kimi until the shared config is mapped
- make the contract tests and README reflect the actual provider behavior
