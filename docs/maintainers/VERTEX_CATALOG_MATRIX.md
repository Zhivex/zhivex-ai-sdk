# Vertex catalog and adapter matrix

Inventory revision: 2026-09-19. Entries: 65.

Generated with `bun scripts/vertex-catalog-audit.ts`. Capabilities come from the
adapter factories, not from the catalog. This is an offline routing/contract
audit, not proof of model access, live behavior or complete platform coverage.

Lifecycle labels are evaluated at the inventory revision date. A retired model
can remain as historical inventory; factory construction does not verify access.

Flags retain the shared ModelCapabilities meanings. In particular, streaming
describes the generic generation contract; Live uses its separate bidirectional
session contract even where that flag is false. Native OCR has no such flags.

| Model | Factory / native client | Lifecycle | Streaming | Tools | Structured output | Vision | Reasoning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-3.5-transcribe-live-preview | realtimeModel | no retirement recorded | no | no | no | no | no |
| gemini-3.5-transcribe-preview | transcriptionModel | no retirement recorded | no | no | no | no | no |
| virtual-try-on-001 | virtualTryOn.generate (native) | no retirement recorded | native contract | native contract | native contract | native contract | native contract |
| multimodalembedding@001 | embeddingModel | no retirement recorded | no | no | no | yes | no |
| ai21/jamba-1.5-mini | languageModel | retired | yes | yes | no | no | no |
| ai21/jamba-1.5-large | languageModel | retired | yes | yes | no | no | no |
| gemini-omni-flash-preview | videoGenerationModel | no retirement recorded | no | no | no | no | no |
| gemini-omni-1.1-flash-preview | videoGenerationModel | no retirement recorded | no | no | no | no | no |
| zai-org/glm-5.2-maas | languageModel | no retirement recorded | yes | yes | yes | no | yes |
| google/gemma-4-26b-a4b-it-maas | languageModel | no retirement recorded | yes | yes | yes | yes | yes |
| openai/gpt-oss-120b-maas | languageModel | no retirement recorded | yes | yes | yes | no | yes |
| meta/llama-4-maverick-17b-128e-instruct-maas | languageModel | no retirement recorded | yes | yes | yes | yes | no |
| meta/llama-4-scout-17b-16e-instruct-maas | languageModel | no retirement recorded | yes | yes | yes | yes | no |
| xai/grok-4.6 | languageModel / responsesModel (global) | no retirement recorded | yes | yes | yes | yes | yes |
| xai/grok-4.3 | languageModel / responsesModel (global) | no retirement recorded | yes | yes | yes | yes | yes |
| xai/grok-4.20-reasoning | languageModel / responsesModel (global) | no retirement recorded | yes | yes | yes | yes | yes |
| xai/grok-4.20-non-reasoning | languageModel / responsesModel (global) | no retirement recorded | yes | yes | yes | yes | no |
| xai/grok-4.1-fast-reasoning | languageModel / responsesModel (global) | retired | yes | yes | yes | yes | yes |
| xai/grok-4.1-fast-non-reasoning | languageModel / responsesModel (global) | retired | yes | yes | yes | yes | no |
| intfloat/multilingual-e5-small-maas | embeddingModel | deprecated | no | no | no | no | no |
| intfloat/multilingual-e5-large-instruct-maas | embeddingModel | deprecated | no | no | no | no | no |
| deepseek-ai/deepseek-ocr-maas | ocr.process (native) | deprecated | native contract | native contract | native contract | native contract | native contract |
| deepseek-ai/deepseek-r1-0528-maas | languageModel | deprecated | yes | yes | yes | no | yes |
| deepseek-ai/deepseek-v3.2-maas | languageModel | deprecated | yes | yes | yes | no | yes |
| deepseek-ai/deepseek-v3.1-maas | languageModel | deprecated | yes | yes | yes | no | yes |
| zai-org/glm-5-maas | languageModel | deprecated | yes | yes | yes | no | yes |
| zai-org/glm-4.7-maas | languageModel | deprecated | yes | yes | yes | no | yes |
| openai/gpt-oss-20b-maas | languageModel | deprecated | yes | yes | yes | no | yes |
| moonshotai/kimi-k2-thinking-maas | languageModel | deprecated | yes | yes | yes | no | yes |
| meta/llama-3.3-70b-instruct-maas | languageModel | deprecated | yes | yes | yes | no | no |
| minimaxai/minimax-m2-maas | languageModel | deprecated | yes | yes | yes | no | yes |
| qwen/qwen3-235b-a22b-instruct-2507-maas | languageModel | deprecated | yes | yes | yes | no | no |
| qwen/qwen3-coder-480b-a35b-instruct-maas | languageModel | deprecated | yes | yes | yes | no | no |
| qwen/qwen3-next-80b-a3b-instruct-maas | languageModel | deprecated | yes | yes | yes | no | no |
| qwen/qwen3-next-80b-a3b-thinking-maas | languageModel | deprecated | yes | yes | yes | no | yes |
| mistralai/mistral-medium-3 | languageModel | no retirement recorded | yes | yes | yes | yes | no |
| mistralai/mistral-small-2503 | languageModel | no retirement recorded | yes | yes | yes | yes | no |
| mistralai/codestral-2 | languageModel / fim (native) | no retirement recorded | yes | yes | yes | no | no |
| mistralai/mistral-ocr-2505 | ocr.process (native) | no retirement recorded | native contract | native contract | native contract | native contract | native contract |
| lyria-3-clip-preview | musicGenerationModel | no retirement recorded | no | no | no | yes | no |
| lyria-3-pro-preview | musicGenerationModel | no retirement recorded | no | no | no | yes | no |
| claude-sonnet-4-6 | languageModel | no retirement recorded | yes | yes | yes | yes | yes |
| claude-opus-4-6 | languageModel | no retirement recorded | yes | yes | yes | yes | yes |
| claude-sonnet-5 | languageModel | no retirement recorded | yes | yes | yes | yes | yes |
| claude-opus-5 | languageModel | no retirement recorded | yes | yes | yes | yes | yes |
| claude-fable-5-1 | languageModel | no retirement recorded | yes | yes | yes | yes | yes |
| gemini-3.8-flash | languageModel | no retirement recorded | yes | yes | yes | yes | yes |
| gemini-3.7-flash | languageModel | no retirement recorded | yes | yes | yes | yes | yes |
| gemini-3.6-flash | languageModel | no retirement recorded | yes | yes | yes | yes | yes |
| gemini-3.5-flash-lite | languageModel | no retirement recorded | yes | yes | yes | yes | yes |
| gemini-3.5-flash | languageModel | no retirement recorded | yes | yes | yes | yes | yes |
| gemini-3.5-live-translate-preview | realtimeModel | no retirement recorded | no | no | no | no | no |
| gemini-3.1-pro-preview | languageModel | no retirement recorded | yes | yes | yes | yes | yes |
| gemini-3.1-flash-lite | languageModel | no retirement recorded | yes | yes | yes | yes | yes |
| gemini-3.1-flash-lite-image | imageGenerationModel | no retirement recorded | no | no | no | yes | no |
| gemini-3.1-flash-image | imageGenerationModel | no retirement recorded | no | no | no | yes | no |
| gemini-3-pro-image | imageGenerationModel | no retirement recorded | no | no | no | yes | no |
| gemini-2.5-flash-image | imageGenerationModel | no retirement recorded | no | no | no | yes | no |
| gemini-live-2.5-flash-native-audio | realtimeModel | no retirement recorded | no | yes | no | yes | yes |
| gemini-3.1-flash-tts-preview | speechModel | no retirement recorded | yes | no | no | no | no |
| gemini-embedding-2 | embeddingModel | no retirement recorded | no | no | no | yes | no |
| veo-3.1-generate-001 | videoGenerationModel | no retirement recorded | no | no | no | no | no |
| veo-3.1-fast-generate-001 | videoGenerationModel | no retirement recorded | no | no | no | no | no |
| veo-3.1-lite-generate-001 | videoGenerationModel | no retirement recorded | no | no | no | no | no |
| lyria-002 | musicGenerationModel | no retirement recorded | no | no | no | yes | no |
