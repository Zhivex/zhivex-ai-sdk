# Provider Smoke Checks

Use provider conformance checks before meaningful stable or prerelease publishes to distinguish declared support, offline contract coverage, installed-package evidence, and authenticated live results.

```bash
bun run smoke:providers
```

The command runs the common live integration suite and emits a schema-versioned Markdown report. Configured capabilities are fail-closed; a permanent or exhausted transient failure returns a non-zero exit code.

```bash
bun run scripts/provider-smoke-report.ts --run-live --gate=required
```

Missing credentials or opt-in service requirements are reported as `skipped_missing_credentials`. That is not a passing live provider check and never certifies support. It remains non-fatal unless that exact provider/capability/evidence level is explicitly required.

## Report Contract

`PROVIDER_CONFORMANCE_REPORT_SCHEMA_VERSION` and the report helpers are Beta exports from `@zhivex-ai/core`, `@zhivex-ai/sdk`, and `@zhivex-ai/sdk/evals`.

The allowed result states are:

| State | Meaning |
| --- | --- |
| `implemented` | Capability is declared by the checkout. No test or provider call is implied. |
| `offline_passed` | Offline adapter/contract suite passed. No provider availability is implied. |
| `installed_passed` | The packed and installed package surface passed its consumer smoke. |
| `live_passed` | The exact provider/model/capability passed an authenticated live check. |
| `skipped_missing_credentials` | Live evidence was not attempted because required configuration was absent. |
| `failed` | The attempted evidence failed; the error summary is redacted. |
| `stale` | Previously observed evidence exceeded its TTL. |

Every result records the exact model, logical endpoint (never a tenant-bearing URL), package name/version, checkout or installed artifact, git SHA, observation time, expiry, attempts, and whether the evidence is required. Prompts, responses, headers, keys, and full provider payloads are not part of the schema. Error and JSON metadata pass through credential/email redaction before persistence.

Generate machine-readable JSON and Markdown after the offline suite has already passed:

```bash
bun run provider:conformance \
  --offline-passed \
  --baseline=scripts/fixtures/provider-conformance-baseline-v1.json \
  --gate=warn \
  --json=.artifacts/provider-conformance.json \
  --markdown=.artifacts/provider-conformance.md
```

`--offline-passed` is an assertion by the caller; CI invokes it only after `bun run test` succeeds. The default TTL is seven days and can be changed with `--ttl-hours`. Use repeatable requirements such as `--required=openai:generateText:live:checkout` with `--gate=required` when the evidence must fail closed.

The repository baseline covers the four priority provider families (OpenAI, Anthropic, Gemini, and Azure OpenAI). Baseline regressions are warnings in the initial CI rollout; changing the CI invocation to `--gate=required` makes them mandatory.

`scripts/package-consumer-smoke.ts` packs every workspace, records SHA-256 for each tarball, imports every JavaScript entrypoint from the installed artifacts, and emits an `installed_passed` `package_import` result per provider package when `ZHIVEX_PROVIDER_CONFORMANCE_INSTALLED_OUTPUT` is set. CI merges that report with offline evidence, uploads JSON plus Markdown for 14 days, and creates a GitHub/Sigstore artifact attestation for the Node 24 report on pushes to `main`.

## Covered Capabilities

The common integration tests cover:

- `generateText`
- `streamText`
- tools
- structured output
- embeddings where supported
- reasoning where supported

Provider-specific integration files may cover additional adapter behavior.

The generic provider smoke records `agent_tool_loop` as declared/offline support but does not certify durable agent persistence or approval/resume. For the
fail-closed Gemini, DeepSeek, Qwen, approval/resume, streaming, and real
Postgres gate, run `bun run test:integration:agents` as documented in
[`AGENT_RELEASE.md`](./AGENT_RELEASE.md).

## Environment Variables

| Provider | Required environment |
| --- | --- |
| `openai` | `OPENAI_API_KEY`; optional `OPENAI_INTEGRATION_MODEL` (defaults to `gpt-5.6-luna`) and `OPENAI_INTEGRATION_EMBEDDING_MODEL` |
| `xai` | `XAI_API_KEY` |
| `meta` | `MODEL_API_KEY`; optional `META_BASE_URL` and `META_INTEGRATION_MODEL`. Smoke defaults to the reduced-cost `muse-spark-1.2-contributor`; production examples continue to use `muse-spark-1.2`. |
| `azure-openai` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `zai` | `ZAI_API_KEY`; optional `ZAI_BASE_URL`, `ZAI_ENDPOINT=general|coding`, `ZAI_INTEGRATION_MODEL` (defaults to `glm-5.3-flash`), `ZAI_INTEGRATION_IMAGE_URL`, and `ZAI_INTEGRATION_IMAGE_MEDIA_TYPE`. |
| `qwen` | `QWEN_API_KEY` or `DASHSCOPE_API_KEY`; optional `QWEN_WORKSPACE_ID`, `QWEN_REGION`, endpoint overrides, and model overrides for extended multimodal/realtime coverage |
| `kimi` | `KIMI_API_KEY` or `MOONSHOT_API_KEY`; optional `KIMI_BASE_URL` or `MOONSHOT_BASE_URL`, plus `KIMI_INTEGRATION_MODEL` (defaults to `kimi-k3`) |
| `bedrock-converse` | `AWS_REGION`; AWS credentials are also required by the default provider chain |
| `bedrock-openai` | `BEDROCK_OPENAI_BASE_URL`, plus `BEDROCK_API_KEY` or `AWS_BEARER_TOKEN_BEDROCK` |
| `ollama` | `OLLAMA_INTEGRATION=1`; a reachable service is required, with optional `OLLAMA_HOST`, `OLLAMA_INTEGRATION_MODEL`, and `OLLAMA_INTEGRATION_EMBEDDING_MODEL`. Direct `ollama.com` also requires `OLLAMA_API_KEY` and skips structured-output and embedding smoke. Thinking smoke is enabled for recognized Qwen 3/3.5, GPT-OSS, DeepSeek R1/v3.1, and Gemma 4 model IDs. |
| `vertex` | `VERTEX_API_KEY` or `GOOGLE_API_KEY`; alternatively `VERTEX_ACCESS_TOKEN` or `GOOGLE_ACCESS_TOKEN` plus `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, or `VERTEX_BASE_URL` |

Optional variables such as provider base URLs, model overrides, API versions, and embedding model overrides are read by `packages/core/tests/integration-registry.ts`.

For the extended DeepSeek V4 smoke, enable the provider-specific suite explicitly:

```bash
DEEPSEEK_EXTENDED_INTEGRATION=1 \
DEEPSEEK_API_KEY=... \
bun run test:integration:deepseek
```

This covers the common capability suites plus live `models.list()`, `balance.get()`, FIM generate/stream, and chat prefix completion. `DEEPSEEK_BASE_URL` and `DEEPSEEK_BETA_BASE_URL` are optional overrides for compatible gateways or test environments. The extended suite is skipped unless both `DEEPSEEK_API_KEY` and `DEEPSEEK_EXTENDED_INTEGRATION=1` are present; a skip is not live validation.

For an authenticated Z.ai GLM-5.3 Flash general-API smoke, opt in explicitly:

```bash
ZAI_API_KEY=... \
ZAI_INTEGRATION_MODEL=glm-5.3-flash \
ZAI_EXTENDED_INTEGRATION=1 \
bun run test:integration:zai
```

Set `ZAI_ENDPOINT=coding` to exercise the same model through GLM Coding Plan. Add `ZAI_INTEGRATION_IMAGE_URL=https://...` and optionally `ZAI_INTEGRATION_IMAGE_MEDIA_TYPE=image/png` to include the vision check. The general Model API and Coding Plan are distinct credential and routing surfaces, so a pass on one does not certify the other. A skipped or fixture-only run is not live validation.

The Kimi K3 smoke path uses `temperature: 1`, `reasoning.effort: "max"`, and `toolChoice: "required"` to match the upstream K3 contract. Override `KIMI_INTEGRATION_MODEL` only when intentionally validating an older K2.x family.

For extended Qwen coverage, enable `QWEN_EXTENDED_INTEGRATION=1` and run `bun run test:integration:qwen`. The provider-specific tests are individually gated by `QWEN_MULTIMODAL_EMBEDDING_MODEL`, `QWEN_RERANK_MODEL`, `QWEN_ASR_MODEL`, `QWEN_TTS_MODEL`, `QWEN_IMAGE_MODEL`, `QWEN_VIDEO_MODEL`, and `QWEN_REALTIME_MODEL`; URL inputs and workspace/endpoint variables are documented in `packages/qwen/README.md`. A skipped surface is not a live validation.

The common Qwen smoke keeps `qwen3.7-plus` as its compatibility default. To certify Qwen 3.8 Flash against the standard international endpoint when the account exposes it there, run:

```bash
QWEN_INTEGRATION_MODEL=qwen3.8-flash \
bun --env-file=.env run test:integration:qwen
```

To certify Qwen 3.8 Max instead, run:

```bash
QWEN_INTEGRATION_MODEL=qwen3.8-max \
bun --env-file=.env run test:integration:qwen
```

Add `QWEN_WORKSPACE_ID=... QWEN_REGION=...` to target a regional workspace explicitly. A provider `access_denied` response proves that the request reached QwenCloud but does not certify the model: confirm that the account, key, and selected region are entitled to that exact model ID.

The common tool-loop check disables thinking only for the hybrid production IDs `qwen3.8-flash` and `qwen3.8-max`, forces the named tool on the first model step, and returns to automatic selection for the final answer. Earlier Qwen families keep their existing smoke behavior, while the thinking-only `qwen3.8-max-preview` is never assigned these overrides.

Passing contract tests without this authenticated run proves adapter behavior, not live provider availability.

## No-Credentials Example

On a machine with no provider credentials configured, live rows use `skipped_missing_credentials` and the summary will resemble:

```text
# Zhivex AI SDK Provider Smoke Report

Generated: 2026-05-06T00:00:00.000Z

Live passed: 0
Skipped credentials: 15 or more capability rows

| Provider | Capability | Evidence | Status | Model | Endpoint | Artifact |
| --- | --- | --- | --- | --- | --- | --- |
| openai | generateText | live | skipped_missing_credentials | gpt-5.6-luna | openai:responses | checkout |
| azure-openai | generateText | live | skipped_missing_credentials | gpt-5.4-nano | azure-openai:default-api-version | checkout |
| anthropic | generateText | live | skipped_missing_credentials | claude-opus-5 | anthropic:messages | checkout |
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
