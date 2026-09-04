# September 2026 Model Refresh

This update targets existing provider adapters and the release-managed SDK catalog. It does not add new provider packages. The frozen compatibility catalog exported by core is intentionally unchanged.

| Surface | Change | Evidence boundary |
| --- | --- | --- |
| OpenAI Astra | Responses default; existing hosted tools, reasoning, cache and structured output mappings; unsupported controls rejected | Offline request/stream tests and authenticated text generation |
| Azure Astra | Responses selection and native reasoning/tool-choice shapes; explicit Responses mode for opaque deployments | Deployment/API-version dependent |
| Claude Fable/Mythos 5.1 | Reject forced tools; typed progress display and thinking-binding controls with beta headers | Mythos requires invitation; no implicit history rewriting |
| Gemini / Vertex 3.8 | Sampling, assistant prefill and reasoning validation | Provider and endpoint scoped |
| Meta 1.3 | Catalog entry and existing Responses reasoning mapping | No inherited pricing; authenticated text generation only |
| Qwen Max snapshot | Exact ID preserved with Max-family validation | Four-digit snapshots only; preview stays distinct |
| Qwen 3.8 open-weight | Discovery entry only | No automatic recommendation or specialized/live certification |
| Ollama Qwen 3.8 | Recognized thinking family and catalog entry | Installed artifact determines exact behavior |
| Lyria 3.5 | Catalog entry for existing music contract | No live certification |
| Kimi K2.5 / K2 preview | Stop recommending retired models; preserve explicit historical lookup | Upstream discontinued |

Provider README update sections link to the exact upstream sources. Fragment revisions record this inventory update; retained older prices keep their original pricing-effective dates. Missing prices are intentionally absent. Catalog recommendations are not live support certificates.

Remaining independent integrations include DeepSeek Responses, xAI image/video/voice, Z.ai OCR/audio/media, Astra async tools and steering, and dedicated Mistral/Cohere/Voyage/Groq/Cerebras providers. They require their own contracts and credentialed validation rather than inheriting unrelated provider behavior.

## Validation observed on September 4, 2026

Typechecking, build and the full test suite passed: 92 test files and 1,530 tests. Documentation checks passed for 73 Markdown files and 19 published packages.

The installed-package smoke passed with 42 imported entrypoints, CLI checks, optional OpenTelemetry peers, the real OpenTelemetry SDK and the deterministic golden path. `release:check` confirmed the existing package versions are in npm, then stopped because this update is uncommitted. No version was published; release readiness still requires a committed source and the protected release workflow.

An authenticated, bounded text-generation smoke passed for `gpt-6-astra`, `gemini-3.8-flash`, `muse-spark-1.3` and `qwen3.8-max-0902`. The `claude-fable-5-1` request returned HTTP 401, so Anthropic live validation remains pending valid credentials. Azure and Vertex were not live-tested in this update. These observations validate text generation only, not live tools, structured output, streaming or full provider certification.
