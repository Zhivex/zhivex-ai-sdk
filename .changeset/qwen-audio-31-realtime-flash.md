---
"@zhivex-ai/qwen": patch
"@zhivex-ai/sdk": patch
---

Add Qwen Audio 3.1 Realtime Flash to the catalog and accept its documented realtime session options, including tools together with web search. Published audio realtime models also accept the documented `smart_turn_v2` turn type, and their `voiceprint_audio_list` events stay on the provider-data path. Stricter voiceprint URL and `search_options.enable_source` checks apply only to 3.1 Flash.
