---
"@zhivex-ai/core": patch
"@zhivex-ai/openai": patch
"@zhivex-ai/qwen": patch
"@zhivex-ai/sdk": patch
"@zhivex-ai/gateway": patch
---

Add Qwen PixVerse V6 video models and send the OpenAI Decisions GA request shape. PixVerse t2v, it2v, kf2v, and r2v validate duration, resolution or size, and reference images before the Singapore video task is submitted. OpenAI `decisionModel` accepts JSON, image URLs, question images, message history, prompt-cache options, safety identifiers, and score descriptions, and reads cache usage. `experimentalDecisionModel` remains a deprecated alias.
