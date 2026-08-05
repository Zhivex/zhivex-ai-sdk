# Provider Smoke Checks

Use provider smoke checks before meaningful stable or prerelease publishes to see which live providers are configured and which integration capabilities will run.

```bash
bun run smoke:providers
```

The command first prints a provider readiness report, then runs the live integration suite:

```bash
bun run scripts/provider-smoke-report.ts
bun run test:integration
```

Missing credentials or opt-in service requirements are reported as `skipped_missing_credentials`. That is not a passing live provider check; it only means the local environment is not configured for that provider. The report exits with code 0 so local machines and CI can run it without requiring every vendor credential or local Ollama service.

## Covered Capabilities

The common integration tests cover:

- `generateText`
- `streamText`
- tools
- structured output
- embeddings where supported
- reasoning where supported

Provider-specific integration files may cover additional adapter behavior.

The generic provider smoke does not certify the durable agent runtime. For the
fail-closed Gemini, DeepSeek, Qwen, approval/resume, streaming, and real
Postgres gate, run `bun run test:integration:agents` as documented in
[`AGENT_RELEASE.md`](./AGENT_RELEASE.md).

## Environment Variables

| Provider | Required environment |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `meta` | `MODEL_API_KEY`; optional `META_BASE_URL` and `META_INTEGRATION_MODEL` |
| `azure-openai` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `qwen` | `QWEN_API_KEY` or `DASHSCOPE_API_KEY`; optional `QWEN_WORKSPACE_ID`, `QWEN_REGION`, endpoint overrides, and model overrides for extended multimodal/realtime coverage |
| `kimi` | `KIMI_API_KEY` or `MOONSHOT_API_KEY`; optional `KIMI_BASE_URL` or `MOONSHOT_BASE_URL`, plus `KIMI_INTEGRATION_MODEL` (defaults to `kimi-k3`) |
| `bedrock-converse` | `AWS_REGION`; AWS credentials are also required by the default provider chain |
| `bedrock-openai` | `BEDROCK_OPENAI_BASE_URL`, plus `BEDROCK_API_KEY` or `AWS_BEARER_TOKEN_BEDROCK` |
| `ollama` | `OLLAMA_INTEGRATION=1`; a reachable local service is required, with optional `OLLAMA_HOST`, `OLLAMA_INTEGRATION_MODEL`, and `OLLAMA_INTEGRATION_EMBEDDING_MODEL` |
| `vertex` | `VERTEX_API_KEY` or `GOOGLE_API_KEY`; alternatively `VERTEX_ACCESS_TOKEN` or `GOOGLE_ACCESS_TOKEN` plus `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, or `VERTEX_BASE_URL` |

Optional variables such as provider base URLs, model overrides, API versions, and embedding model overrides are read by `packages/core/tests/integration-registry.ts`.

For the extended DeepSeek V4 smoke, enable the provider-specific suite explicitly:

```bash
DEEPSEEK_EXTENDED_INTEGRATION=1 \
DEEPSEEK_API_KEY=... \
bun run test:integration:deepseek
```

This covers the common capability suites plus live `models.list()`, `balance.get()`, FIM generate/stream, and chat prefix completion. `DEEPSEEK_BASE_URL` and `DEEPSEEK_BETA_BASE_URL` are optional overrides for compatible gateways or test environments. The extended suite is skipped unless both `DEEPSEEK_API_KEY` and `DEEPSEEK_EXTENDED_INTEGRATION=1` are present; a skip is not live validation.

The Kimi K3 smoke path uses `temperature: 1`, `reasoning.effort: "max"`, and `toolChoice: "required"` to match the upstream K3 contract. Override `KIMI_INTEGRATION_MODEL` only when intentionally validating an older K2.x family.

For extended Qwen coverage, enable `QWEN_EXTENDED_INTEGRATION=1` and run `bun run test:integration:qwen`. The provider-specific tests are individually gated by `QWEN_MULTIMODAL_EMBEDDING_MODEL`, `QWEN_RERANK_MODEL`, `QWEN_ASR_MODEL`, `QWEN_TTS_MODEL`, `QWEN_IMAGE_MODEL`, `QWEN_VIDEO_MODEL`, and `QWEN_REALTIME_MODEL`; URL inputs and workspace/endpoint variables are documented in `packages/qwen/README.md`. A skipped surface is not a live validation.

The common Qwen smoke keeps `qwen3.7-plus` as its compatibility default. To certify the final Qwen 3.8 model against the standard international endpoint when the account exposes it there, run:

```bash
QWEN_INTEGRATION_MODEL=qwen3.8-max \
bun --env-file=.env run test:integration:qwen
```

Add `QWEN_WORKSPACE_ID=... QWEN_REGION=beijing` to target the currently documented Beijing Responses workspace explicitly.

Passing contract tests without this authenticated run proves adapter behavior, not live provider availability.

## No-Credentials Example

On a machine with no provider credentials configured, the report will look like this:

```text
# Zhivex AI SDK Provider Smoke Report

Generated: 2026-05-06T00:00:00.000Z

Ready providers: 0/14
Skipped providers: 14/14

| Provider | Status | Text model | Capabilities | Missing requirements |
| --- | --- | --- | --- | --- |
| openai | skipped_missing_credentials | gpt-5.4-nano | generateText, streamText, tools, structured output (native), embeddings, reasoning | OPENAI_API_KEY |
| azure-openai | skipped_missing_credentials | gpt-5.4-nano | generateText, streamText, tools, structured output (native), embeddings, reasoning | AZURE_OPENAI_API_KEY; AZURE_OPENAI_ENDPOINT |
| anthropic | skipped_missing_credentials | claude-3-5-sonnet | generateText, streamText, tools, structured output (prompted), reasoning | ANTHROPIC_API_KEY |
```

The real output includes every provider in the registry.

## Release Guidance

Run this before publishing or validating a release candidate:

```bash
bun run typecheck
bun run test
bun run build
bun run smoke:providers
```

For a release confidence note, record the provider report along with whether `test:integration` ran live provider cases or skipped them due to missing credentials.
