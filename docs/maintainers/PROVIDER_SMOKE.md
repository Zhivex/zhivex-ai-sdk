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

Missing credentials are reported as `skipped_missing_credentials`. That is not a passing live provider check; it only means the local environment is not configured for that provider. The report exits with code 0 so local machines and CI can run it without requiring every vendor credential.

## Covered Capabilities

The common integration tests cover:

- `generateText`
- `streamText`
- tools
- structured output
- embeddings where supported
- reasoning where supported

Provider-specific integration files may cover additional adapter behavior.

## Environment Variables

| Provider | Required environment |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `azure-openai` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `qwen` | `QWEN_API_KEY` or `DASHSCOPE_API_KEY` |
| `kimi` | `KIMI_API_KEY` or `MOONSHOT_API_KEY` |
| `bedrock-converse` | `AWS_REGION`; AWS credentials are also required by the default provider chain |
| `bedrock-openai` | `BEDROCK_OPENAI_BASE_URL`, plus `BEDROCK_API_KEY` or `AWS_BEARER_TOKEN_BEDROCK` |
| `vertex` | `VERTEX_API_KEY` or `GOOGLE_API_KEY`; alternatively `VERTEX_ACCESS_TOKEN` or `GOOGLE_ACCESS_TOKEN` plus `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, or `VERTEX_BASE_URL` |

Optional variables such as provider base URLs, model overrides, API versions, and embedding model overrides are read by `packages/core/tests/integration-registry.ts`.

## No-Credentials Example

On a machine with no provider credentials configured, the report will look like this:

```text
# Zhivex AI SDK Provider Smoke Report

Generated: 2026-05-06T00:00:00.000Z

Ready providers: 0/11
Skipped providers: 11/11

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
