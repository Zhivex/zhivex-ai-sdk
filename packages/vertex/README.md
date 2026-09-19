# @zhivex-ai/vertex

Vertex AI / Gemini Enterprise Agent Platform adapter for Zhivex AI SDK.

Supports Claude text, tools, and streaming through the Anthropic publisher, plus Vertex Gemini text, multimodal embeddings, speech, realtime sessions, grounded generation, Context Caching, Batch API, raw prediction calls, and current Google generative media endpoints for Gemini Image, Veo 3.1, Lyria 2, and Gemini Omni / Lyria 3 through Interactions.

Google is transitioning Vertex AI into Gemini Enterprise Agent Platform. The SDK keeps the package name `@zhivex-ai/vertex`, the factory `createVertex()`, and provider id `"vertex"` for backwards compatibility and because the public API endpoints still use `aiplatform.googleapis.com`. Treat "Vertex" in this package as the Google Cloud Agent Platform / Vertex API surface, not as a separate deprecated wire contract.

This provider covers Google and partner model routes. A model's author and its
API host are separate: Claude, E5 and other publisher models invoked here still
use the `vertex` provider, Google Cloud authentication and Google billing.
Implemented capabilities do not imply that every model is enabled in your project.
See [verification and remaining limits](#verification-and-remaining-limits).

## Install

For HTTP operations, request deadlines and abort signals also bound waiting for
ADC or custom `getAccessToken()` credentials. A late token does not send a request
after cancellation. The credential resolver itself may continue in the background
because its interface does not accept an abort signal.

Requires Node.js 22 or newer when running on Node, matching Google Auth Library 11.

```bash
bun add @zhivex-ai/core @zhivex-ai/vertex @zhivex-ai/gateway
```

| Surface | Support |
| --- | --- |
| Text, tools, structured output, audio input | `generateText()` |
| Multimodal embeddings | `embeddingModel("gemini-embedding-2")` |
| E5 text embeddings | `embeddingModel("intfloat/multilingual-e5-small-maas")`; OAuth required |
| Speech and realtime sessions | `generateSpeech()`, `streamSpeech()`, and `realtimeModel()`; model and location dependent |
| Context Caching and Batch API | high-level |
| Google Search, Google Maps, URL Context, Code Execution, Computer Use | hosted tool helpers where the selected endpoint supports them |
| Image, video, music generation | high-level |
| Claude on Vertex | `vertex("claude-...")`: text, client tools, streaming, reasoning, native structured output on supported models |
| Publisher models / Model Garden | `predictionModel("publishers/<publisher>/models/<id>")`: explicit raw contract; bare IDs default to Google |
| Partner chat | `vertex("publisher/model")`: normalized chat, tools and streaming according to model capabilities |
| Interactions / Lyria 3 | `interactions` (experimental project-scoped API) |
| Mistral OCR / Codestral FIM | `ocr.process()` / `fim.generate()` / `fim.stream()` |
| DeepSeek OCR | `ocr.process()` with one image and optional extraction prompt |
| Gemini Files API, Gemini File Search stores | explicit unsupported surface in this adapter |

```ts
import {
  createBatch,
  createContextCache,
  generateImage,
  generateMusic,
  generateText,
  generateVideo,
  googleMapsTool,
  googleUrlContextTool,
  predictRaw,
  streamSpeech
} from "@zhivex-ai/core";
import { createVertex } from "@zhivex-ai/vertex";

const vertex = createVertex({
  apiKey: process.env.GOOGLE_API_KEY
});

const productionVertex = createVertex({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION ?? "global"
});

const advancedProductionVertex = createVertex({
  getAccessToken: async () => {
    // Optional: supply your own service-account or token-broker integration.
    return process.env.VERTEX_ACCESS_TOKEN!;
  },
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION ?? "global"
});

for await (const chunk of await streamSpeech({
  model: productionVertex.speechModel!("gemini-3.1-flash-tts-preview"),
  input: "Read this announcement as it is generated.",
  voice: "Kore"
})) {
  console.log(chunk.mediaType, chunk.audio.byteLength);
}

const live = await productionVertex
  .realtimeModel!("gemini-live-2.5-flash-native-audio")
  .connect({
    outputAudioMediaType: "audio/pcm",
    outputAudioTranscription: true
  });
await live.close();

await generateImage({
  model: productionVertex.imageGenerationModel!("gemini-3.1-flash-lite-image"),
  prompt: "Create a product photo"
});

await generateVideo({
  model: productionVertex.videoGenerationModel!("veo-3.1-generate-001"),
  prompt: "Create a cinematic establishing shot"
});

await generateMusic({
  model: productionVertex.musicGenerationModel!("lyria-002"),
  prompt: "Create a short instrumental intro"
});

await generateText({
  model: vertex("gemini-3.7-flash"),
  prompt: "Use URL context for the linked source.",
  tools: {
    urls: googleUrlContextTool()
  }
});

const nearby = await generateText({
  model: vertex("gemini-3.7-flash"),
  prompt: "Find well-reviewed cafes near this location.",
  tools: {
    maps: googleMapsTool({ latitude: 34.050481, longitude: -118.248526 })
  }
});
console.log(nearby.text, nearby.rawResponse);

await createContextCache({
  provider: productionVertex,
  modelId: "gemini-3.7-flash",
  contents: [{ role: "user", parts: [{ type: "file", data: "gs://bucket/large.pdf", mediaType: "application/pdf" }] }]
});

await createBatch({
  provider: productionVertex,
  modelId: "gemini-3.7-flash",
  fileName: "gs://my-bucket/batch-input.jsonl",
  providerOptions: {
    outputConfig: {
      predictionsFormat: "jsonl",
      gcsDestination: { outputUriPrefix: "gs://my-bucket/batch-output/" }
    }
  }
});

await predictRaw({
  model: advancedProductionVertex.predictionModel!("publisher-model-id"),
  instances: [{ prompt: "provider-specific request" }],
  parameters: { temperature: 0.2 }
});
```

Authentication follows the current Google guidance for Gemini on Vertex AI: API keys are supported for testing with `apiKey`, `VERTEX_API_KEY`, or `GOOGLE_API_KEY`, while production can use automatic ADC with `createVertex({ projectId, location })` or explicit service-account integrations through `authClient`, `getAccessToken`, or `accessToken`. See Google's guides for [API keys](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys), the [Vertex AI quickstart](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start?usertype=apikey), and [Vertex AI authentication](https://docs.cloud.google.com/vertex-ai/docs/authentication).

Diagnostic response-size errors strip query strings, fragments, and embedded credentials from endpoint URLs before they are exposed, so API-key query parameters are never copied into error messages.

Use `location: "global"` for the broadest current Gemini 3 availability. The global REST host is `aiplatform.googleapis.com`; regional hosts use `<location>-aiplatform.googleapis.com`. Because Veo 3.1 is not served from the global endpoint, `videoGenerationModel("veo-...")` automatically routes a global Vertex provider to `us-central1`; explicit non-global locations and custom `baseURL` values remain unchanged. Gemini 3.7 Flash and Gemini 3.6 Flash are currently served only from `global`; Gemini 3.5 Flash-Lite supports `global` plus the `us` and `eu` jurisdictional multi-regions. The adapter rejects unsupported configured locations for these stable IDs unless a custom `baseURL` is supplied. Model features, pricing, data residency, and Provisioned Throughput differ by location, so choose a non-global location only after checking the selected model's location table.

Current model guidance:

- Complex text, multimodal, coding, and multi-step agentic work: `gemini-3.7-flash`.
- High-volume extraction, routing, document parsing, and low-latency subagent work: `gemini-3.5-flash-lite`. It defaults to minimal thinking; use medium or high for autonomous multi-step agents.
- Image generation: `gemini-3.1-flash-lite-image`, `gemini-3.1-flash-image`, or `gemini-3-pro-image`. The Flash-Lite image model has shorter lifecycle guarantees than the 12-month GA image models.
- Video: use the Google Cloud IDs `veo-3.1-generate-001`, `veo-3.1-fast-generate-001`, and `veo-3.1-lite-generate-001`. The Gemini Developer API uses different Veo `*-preview` IDs.
- Embeddings: `gemini-embedding-2` is the current multimodal model and is available on `global`, `us`, and `eu`.
- Speech: `gemini-3.1-flash-tts-preview` supports buffered `generateSpeech()` and incremental `streamSpeech()` output. It is currently available through the Vertex AI API on `global`; older Gemini 2.5 TTS models have broader regional coverage.
- Music: `lyria-002` is the GA model supported by `musicGenerationModel()`. Lyria 3 uses the experimental project-scoped Interactions API with bearer credentials and `location: "global"`.
- Imagen 4 and older Veo endpoints are intentionally no longer recommended here; Google Cloud required migration away from them by June 30, 2026.
- Legacy Imagen `outputMimeType` maps to `parameters.outputOptions.mimeType`; native `providerOptions.outputOptions.compressionQuality` is preserved. Conflicting MIME settings are rejected. The text-to-image factory rejects `images` rather than silently ignoring them; native editing requires the separate `referenceImages` prediction contract. This does not restore access to retired models.

Gemini 3.7 Flash, Gemini 3.6 Flash, and Gemini 3.5 Flash-Lite use provider-managed sampling. Do not pass `temperature`, `topP` / `top_p`, `topK` / `top_k`, `candidateCount` / `candidate_count`, or frequency/presence penalties; the adapter rejects those controls locally for these model IDs. Gemini 3.7 accepts `reasoning.effort` values `low`, `medium`, and `high`; Gemini 3.6 and Gemini 3.5 Flash-Lite also accept `minimal`. All three reject a final assistant/model-output prefill. The current Google Cloud endpoint does not expose Computer Use for these models, so their Vertex model capabilities report it as unsupported.

The mutable aliases `gemini-flash-latest` and `gemini-flash-lite-latest` are available upstream but can be remapped. Prefer the stable IDs above for production workloads and reproducible pricing.

The built-in catalog's Gemini 3.7 Flash, Gemini 3.6 Flash, and Gemini 3.5 Flash-Lite rates represent Standard global text-token pricing. Non-global Vertex endpoints can cost more, and media, tools, Batch/Flex, Priority, tuning, and Provisioned Throughput use separate pricing.

`videoGenerationModel("gemini-omni-flash-preview")` and `videoGenerationModel("gemini-omni-1.1-flash-preview")` route text-to-video and image-to-video through Vertex Interactions with bearer credentials and `location: "global"`. They generate one video per synchronous call, accept integer durations from 3 to 10 seconds, aspect ratios `16:9` / `9:16`, and optional `outputStorageUri` for GCS delivery. `providerOptions.resolution` supports `720p` on Omni and `360p`, `720p`, `1080p`, `4k` on Omni 1.1. Negative prompts and polling controls are rejected. Use `vertex.interactions` for reference-to-video, first/last-frame, editing and asynchronous workflows. Managed-agent inference is accessible through `interactions.create({ agent, input, background: true })`; provisioning and deployment administration are separate APIs.

When Google Maps grounding is enabled, retain the provider response metadata and render the returned source names and Google Maps links directly after the grounded content. Google requires those sources and its text attribution to remain visible to the end user.

See Google's current [Agent Platform model lifecycle](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions), [Gemini 3.7 Flash model card](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-7-flash), [Gemini 3.6 Flash model card](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-6-flash), [Gemini 3.5 Flash-Lite model card](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite), [Gemini TTS on Vertex](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts), [Maps grounding requirements](https://ai.google.dev/gemini-api/docs/maps-grounding), [deployment locations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations), [pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing), and [release notes](https://docs.cloud.google.com/gemini-enterprise-agent-platform/release-notes).

Google's current product page labels this surface as [Gemini Enterprise Agent Platform, formerly Vertex AI](https://cloud.google.com/products/gemini-enterprise-agent-platform), and Google's migration docs say Vertex AI is transitioning to become part of Agent Platform. This package intentionally does not rename the provider id yet; doing so would be a breaking API change without a corresponding endpoint-level migration requirement.

Model Garden raw prediction accepts explicit `publishers/<publisher>/models/<id>` resources, relative to the configured project and location. Bare prediction IDs retain the Google publisher default. Supply the model-specific `body` and `providerOptions.action` (for example `rawPredict`) to `predictRaw()`. This is transport access, not a promise of normalized tools, streaming, or support for every Model Garden deployment. Self-deployed endpoints use `predictionModel("endpoints/<id>")` or a fully qualified `projects/<project>/locations/<location>/endpoints/<id>` resource. Both require bearer credentials and use the deployed model's raw request/response contract; they do not automatically provide normalized chat or streaming.

Callable tool inputs are validated locally against their Zod schemas. Gemini
requests map those schemas to Vertex parameters, removing unsupported JSON
Schema metadata and `additionalProperties`, including nested schemas.

## Claude on Vertex

The package, factory, and provider identity remain `@zhivex-ai/vertex`, `createVertex()`, and `vertex`. Claude uses Google's bearer authentication and billing, with the Anthropic Messages protocol at `publishers/anthropic`; no Anthropic API key is needed.

```ts
const claudeVertex = createVertex({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-east5"
});
const answer = await generateText({
  model: claudeVertex("claude-sonnet-4-6"),
  prompt: "Explain why the sky is blue.",
  maxTokens: 256
});
console.log(answer.text);
```

Enable the selected Claude model in Model Garden and choose a supported location. Use ADC or `authClient`, `getAccessToken`, or `accessToken`; API-key/Express mode is rejected for Claude and other partner publisher predictions. If a Google API-key environment variable is configured, remove it for ADC or pass an explicit bearer credential source. Model IDs, including `@revision` suffixes, are sent as supplied; availability is determined by Google for your project and region.

Supported through the shared language-model API: text, image/document input using Anthropic message mapping, client tool loops, streaming, usage, reasoning, and native structured output for Claude 4.5 and later families. Structured output additionally requires the Google organization policy to allow `structured_outputs`. Capabilities describe the implemented contract, not a guarantee of account entitlement or live certification.

Supported Claude native tools include web search (`web_search_20250305`), computer use (`computer_20250124`), Bash, text editor, memory and tool search. Use `hostedTool({ provider: "vertex", type, name, config })`; computer use adds its required beta to the Vertex request body. Unsupported server tools (web fetch/code execution/advisor), direct Anthropic Files API IDs and URL input sources, remote MCP, unrecognized betas, fast mode, server-side fallbacks and direct-API context-management options are explicitly rejected. SDK-managed MCP tools can still execute as ordinary client tools. Google grounding, Gemini cache/batch/media APIs, Interactions, and managed Agent Platform runtime/session/deployment APIs are not Claude language-model features exposed here.

The SDK catalog includes Claude entries under `vertex` separately from `anthropic`, without copying direct-API prices or automatic recommendations. Contract tests use mocked HTTP; the opt-in `VERTEX_CLAUDE_INTEGRATION_MODEL` suite validates the actual Google route when credentials and model access are available.

Sources: [Claude requests on Vertex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/use-claude), [Claude structured outputs on Vertex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/structured-outputs).

### Claude prompt caching

`providerOptions.cache_control = { type: "ephemeral", ttl: "1h" }` enables
supported automatic prompt caching; `5m` is also accepted. Explicit block-level
breakpoints can be supplied in Anthropic protocol `provider-data` blocks. Older
Claude 3.7 Sonnet / 3.5 Sonnet / 3 Opus reject a one-hour TTL. Cache read and write
tokens are normalized in usage. On `global`, set `providerOptions.sessionId` to a
stable application session ID for the `X-Vertex-Ai-Session-Id` routing header.
Neither this ID nor Anthropic credentials are serialized as model inputs.
`VertexClaudeOptions` provides the typed options contract.

References: [Claude feature availability](https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai),
[Google prompt caching](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/prompt-caching),
[Google Claude web search](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/web-search).

### Claude context management

Automatic context compaction and context editing use Vertex beta flags in the
request body. The adapter adds the appropriate flags for these native options:

```ts
await vertex("claude-sonnet-4-6").generate({
  messages: [{ role: "user", parts: [{ type: "text", text: "Continue the task." }] }],
  providerOptions: {
    context_management: {
      edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 100000 } }],
    },
  },
});
```

Supported strategies are `compact_20260112`, `clear_tool_uses_20250919` and
`clear_thinking_20251015`. Thinking clearing must come first when combined with
other edits. Automatic compaction requires a supported Claude model and a trigger
of at least 50,000 input tokens. Preserve returned provider-data blocks in the
conversation history. These features are beta and their availability depends on
the model. On-demand `compaction` and `compact-2026-09-04` are not available on
Vertex and are rejected. See Anthropic's
[context management availability](https://platform.claude.com/docs/en/build-with-claude/overview)
and [compaction contract](https://platform.claude.com/docs/en/build-with-claude/compaction).

### Count Claude input tokens

```ts
const count = await vertex.claude.countTokens({
  modelId: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "How many tokens are in this request?" }],
});
console.log(count.inputTokens);
```

This method accepts native Claude message content (text or content-block arrays),
plus `system`, `tools`, `thinking` and `toolChoice`. It calls the dedicated
`publishers/anthropic/models/count-tokens:rawPredict` endpoint, with the target
model in the body. Configure `global`, `us`, `eu` or `asia-southeast1` and OAuth
credentials. It does not fall back to a generation request. HTTP failures and
invalid count responses are surfaced explicitly. See Google's
[Claude token-counting reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/count-tokens).

### Claude browser toolsets

Compatible Claude models accept the native `browser_toolset_20260801` declaration:

```ts
import { hostedTool } from "@zhivex-ai/core";

const browser = hostedTool({
  provider: "vertex", type: "browser_toolset_20260801", name: "browser",
});
const model = vertex("claude-opus-5");
const turn = await model.generate({
  messages: [{ role: "user", parts: [{ type: "text", text: "Open example.com." }] }],
  tools: { browser },
});
```

Use the low-level `generate()` / `stream()` loop with your browser executor. The
SDK returns each member call with `providerMetadata.toolset_name = "browser"`.
Execute members sequentially in response order. Return a `tool-result` with that
same metadata and either text or a native content-block array in `output` (for
example `text`, `image` and `browser_state` blocks). If one action fails, mark it
and the remaining actions in that batch as errors instead of executing later
steps. Append the assistant message and all results before requesting the next
turn. The application owns browser execution and permissions; declaring this
native toolset does not register callable member executors with `generateText()`.

The SDK's local tool name is omitted from the native declaration. Supported
models are Opus 4.8/5, Sonnet 5 and Fable/Mythos 5/5.1 where available on Vertex.
Other model IDs reject the declaration before network access. See the official
[browser toolset contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool)
for member parameters and native result blocks. Offline tests cover declaration,
streaming identity and the complete call/result replay; live validation is pending.

## Gemini 3.8 Flash

`gemini-3.8-flash` is included in the catalog and uses the same local sampling, prefill, and reasoning validation as the current Vertex Flash family. Accepted reasoning efforts are `low`, `medium`, and `high`. Unlike the earlier Flash releases, 3.8 exposes Computer Use (Preview) and supports `global`, `us`, and `eu` locations. Availability must be verified for the selected project, endpoint, and location. The Vertex adapter does not inherit Gemini API-only surfaces or pricing.

See the [Google Cloud model card](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash).

## Native Vertex resources

### Arbitrary HTTP predictions on deployed endpoints

`vertex.endpoints.rawPredict()` preserves binary or text payloads and returns
response bytes without JSON serialization or parsing. For example:

```ts
const endpoint = createVertex({ projectId: "my-project", location: "us-central1" });
const response = await endpoint.endpoints.rawPredict({
  endpoint: "endpoints/my-endpoint-id",
  body: new Uint8Array([0, 255, 128]),
  contentType: "application/octet-stream",
  maxResponseBytes: 4 * 1024 * 1024,
  timeoutMs: 30_000,
  maxRetries: 0,
});
// response.body, contentType, status, endpointId and deployedModelId
```

The deployed container defines the input and output formats. Use Google bearer
credentials/ADC and the endpoint's region; full project-qualified endpoint names
are also accepted, without changing the configured host. The default response
limit is 16 MiB, enforced before and during consumption. Shared deadlines,
cancellation and explicit HTTP retries apply. This unary method does not decode
streams; existing `predictionModel(...).rawPredict()` remains the JSON contract.
For streaming containers, `vertex.endpoints.streamRawPredict()` accepts the same
input and returns an async iterable: a `response` event with HTTP metadata,
followed by `chunk` events containing raw `data: Uint8Array`. Chunk boundaries
are transport boundaries; applications must decode their container's protocol.
The size limit applies to the accumulated stream. Breaking the loop cancels the
body; abort and deadline also interrupt a stalled read. HTTP errors can be
retried before yielding events, but an interrupted response body is never replayed.
Contract and installed-package tests cover binary payloads; live validation still
requires a deployed endpoint. See [Google's rawPredict API](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/projects.locations.endpoints/rawPredict).
The streaming route follows [streamRawPredict](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/projects.locations.endpoints/streamRawPredict).

For a custom container exposing a gRPC model server, use
`vertex.endpoints.directRawPredict({ endpoint, methodName, input })`, where
`methodName` is a fully qualified method such as
`/tensorflow.serving.PredictionService/Predict` and `input` is its serialized
request as `Uint8Array`. The client sends the REST base64 envelope and returns
`output: Uint8Array` plus HTTP status. Applications own protobuf serialization;
this is not a native gRPC channel. `maxResponseBytes` bounds decoded output
(16 MiB default); the JSON envelope is bounded separately with base64 overhead.
Empty bytes, including an omitted default output field, remain empty bytes.
The same auth, timeout and retry options apply. See
[directRawPredict](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/projects.locations.endpoints/directRawPredict).

For bidirectional gRPC containers, use
`vertex.endpoints.streamDirectRawPredict({ endpoint, methodName, inputs })`
with an iterable or async iterable of `Uint8Array` messages, or
`vertex.endpoints.streamDirectPredict({ endpoint, inputs })` with tensor frames
`{ inputs: VertexTensor[], parameters?: VertexTensor }`. Iterate the returned
async iterable to receive bytes or `{ outputs, parameters? }` respectively.
`vertex.endpoints.streamingRawPredict()` and
`vertex.endpoints.streamingPredict()` expose the separate StreamingRawPredict
and StreamingPredict RPCs with the same byte and tensor input contracts. Select
the RPC supported by your deployed container; no automatic fallback is applied.

For a single request followed by multiple responses, use
`vertex.endpoints.serverStreamingPredict({ endpoint, inputs, parameters })`.
Here `inputs` is a `VertexTensor[]`, not an iterable of request frames. The
result is an async iterable of `{ outputs, parameters? }`. This client uses the
server-streaming gRPC RPC for deployed endpoints or publisher model resources
(`publishers/<publisher>/models/<model>` or the project-qualified form), using
the configured API host. A model resource does not imply that the model supports
this RPC. Other direct/bidirectional methods still require deployed endpoints.
It shares the same response
limits, cancellation and no-replay behavior.

These methods use the official Google gRPC client and bearer authentication;
they do not use the configured HTTP `fetch` implementation. Native service
failures retain the Google gRPC error fields (`code`, `details`, `metadata`);
they are not `ProviderHTTPError` instances. SDK configuration, cancellation and
response-limit errors retain their existing contracts. The first request
carries endpoint routing metadata; subsequent requests carry input frames.

Set `timeoutMs` or `abortSignal` to bound the session. Leaving the response loop
cancels both directions and closes the client. `maxResponseBytes` bounds the
cumulative raw output bytes or serialized tensor output (16 MiB by default),
and also configures the gRPC per-message receive limit. Streaming inputs cannot
be replayed: `maxRetries` must be omitted or zero. These methods require a
deployed endpoint supporting the corresponding bidirectional protocol.

`vertex.endpoints.directPredict({ endpoint, inputs, parameters })` provides the
native REST tensor contract for compatible gRPC model servers. `inputs` and
returned `outputs` are `VertexTensor[]`; optional `parameters` is a tensor too.
`shape`, `int64Val` and `uint64Val` use decimal strings to avoid JavaScript number
precision loss. Byte fields retain base64 strings; floating fields accept finite
numbers or the ProtoJSON strings `NaN`, `Infinity` and `-Infinity`. Nested
`listVal`/`structVal` tensors are preserved with a maximum nesting depth of 32.
Invalid field types, 64-bit ranges and incompatible scalar representations are
rejected; the model server owns tensor shape and model-specific validation.
`maxResponseBytes` bounds the JSON response (16 MiB default). See the native
[directPredict](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/projects.locations.endpoints/directPredict)
and [Tensor](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/Tensor) contracts.

`vertex.endpoints.explain({ endpoint, instances, parameters, deployedModelId,
explanationSpecOverride })` returns native `explanations`, `predictions` and the
serving `deployedModelId`. It preserves attribution/example details and checks
that the response has one explanation for each input instance. Overrides may
set native `parameters`, `metadata` or `examplesOverride`; their contents depend
on the model. The selected deployed model must already have an `explanationSpec`
configured; without a selected ID, all deployed models must have it. Response
JSON is bounded to 16 MiB by default, configurable through `maxResponseBytes`.
This API does not configure the deployment or implement attribution locally.
See [online explanations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/projects.locations.endpoints/explain).

### Batch, cache and generated media operations

Native image, music and video generation honor configured HTTP retries and bound
backoff by the overall deadline. Video polling retries the existing operation
without resubmitting generation. Submission retries remain opt-in and can incur
additional generation work; they do not imply server-side deduplication.

Batch input selects exactly one source: `fileName` or `providerOptions.inputConfig`.
For BigQuery, `fileName` identifies a table as `bq://project.dataset.table`.
Configure `outputConfig.predictionsFormat` as `bigquery` and
`outputConfig.bigqueryDestination.outputUri` for BigQuery output. The request
mapping has contract coverage; a real BigQuery batch lifecycle remains unverified.

`predictionModel().predictRaw()` uses `providerOptions.action` to select the URL
action and omits it from the generated body. Supply model-native fields directly
in `body` to preserve the raw payload unchanged. Without an explicit body,
provider options cannot override dedicated `instances` or `parameters` fields.
Operation polling takes its identity from `name` and rejects native overrides.

Native prediction methods and operation polling honor `maxRetries` for transient
HTTP errors, with retry backoff bounded by the request timeout. Retries are off
by default. A retry of a submission can execute it again; this API does not add
an idempotency key or guarantee deduplication for deployed models.

`gemini-embedding-2` uses `embedContent` and accepts text or `MediaInput` values
(inline data or Cloud Storage URIs). Legacy text embedding models continue to use
`predict`. Each value produces one vector in caller order.

Batch model selectors accept `publisher/model` as well as full publisher resources.
Transient HTTP failures respect the configured retry policy. A bounded ADC/GCS
check verified Gemini 2.5 Flash batch creation, completion, expected output and
job deletion in `us-central1`; its temporary storage was removed and absence
confirmed. Partner batch and BigQuery need separate live evidence. A separate live check
verified cancellation through JOB_STATE_CANCELLED and cleanup with 404 checks.
The Claude smoke uses `start STATE_FILE --claude` for one Sonnet 4.6 request
on `us-east5`, with a temporary private bucket in `us-central1`. The tested
project returned 404 at job creation; no job ID was returned. This does not
establish whether the cause is model access or service availability. Follow-up
commands use the same state file without the flag. Its temporary storage was
removed; Claude batch completion remains unverified.

Batch operations use the project-scoped `batchPredictionJobs` API with Google
Cloud bearer credentials. Supply `fileName` as a `gs://` JSONL or `bq://` table
URI, or pass `providerOptions.inputConfig`; also supply
`providerOptions.outputConfig`. Gemini Developer API `files/*` IDs and inline
`requests` are not Vertex batch inputs. Model availability for batch must be
checked separately from online prediction locations. Claude IDs route to the
Anthropic publisher; explicit publisher resources are accepted for other models.
Partner batch creation requires a supported regional endpoint: `global` is
rejected locally, including when the model resource contains a regional prefix.
The client's location determines where the job is created. See the
[Claude batch contract](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/batch).
Cancellation returns the job's current state after requesting cancellation;
deletion returns the raw long-running operation for inspection.

US/EU jurisdictional endpoints use `aiplatform.us.rep.googleapis.com` and
`aiplatform.eu.rep.googleapis.com`. Full cache/job resource names returned by
Google can be passed directly to their get/delete/cancel methods.

## Partner chat and deployed chat endpoints

Use publisher-qualified IDs for managed open models. These requests use Google
Cloud bearer credentials and billing; direct provider API keys are not used.

```ts
const cloud = createVertex({ projectId: "my-project", location: "global" });
const answer = await generateText({
  model: cloud("xai/grok-4.3"),
  prompt: "Explain this architecture"
});

const deployed = cloud.chatModel("my-deployed-model", {
  endpoint: "endpoints/123456789",
  capabilities: { tools: true, toolChoice: true, structuredOutput: true }
});
```

The callable factory recognizes `xai/`, `meta/`, `deepseek-ai/`, `qwen/`,
`zai-org/`, `moonshotai/`, `minimaxai/`, `openai/` and `google/gemma*` selectors
and routes them through `endpoints/openapi/chat/completions`. `mistralai/` and
`ai21/` use publisher `rawPredict` / `streamRawPredict` with the chat contract.
Bare `grok-*`, `mistral-*`, `codestral*` and `jamba-*` IDs are qualified with their
publisher. Jamba 1.5 Mini and Large retired on February 27, 2026; their catalog entries retain this lifecycle history and do not indicate current availability. See the [partner retirement schedule](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/partner-models). Mistral OCR is a separate document API and is rejected by chat.
Mistral publisher calls map the shared `toolChoice: "required"` to native `any`.
Managed Mistral rejects `providerOptions.safe_prompt`, including `false`.
The legacy Jamba profile exposes JSON-object mode without claiming native
JSON-schema output; requests combining streaming and tools are rejected locally.
These managed-host restrictions do not override explicitly configured custom
deployment capabilities.
Model access and location support remain Google-account dependent; a recognized
selector is not live certification or a guarantee that every publisher model
speaks the chat protocol. Advanced capabilities and thinking controls are selected by exact managed model IDs; unknown IDs retain text/stream transport but do not inherit tools, schema output, vision or reasoning from a name prefix. Mistral/AI21 `@revision` selectors retain the base model profile. Codestral FIM and OCR require their specialized APIs.
Google-only factories (grounding, media, Live and explicit context caching)
reject recognized partner selectors before sending a request. E5 embeddings
use their own embedding route rather than the Google embedding API.

The SDK catalog includes GLM 5.2 Preview, Gemma 4 26B, both Llama 4 variants
and gpt-oss 120B. A Preview minimum-availability date is not a retirement date;
GLM 5.2 does not inherit the October retirement of GLM 5.

Client tool loops, native JSON-schema output, image inputs on supported models,
usage and text streaming use the shared SDK contract. Hosted direct-provider
tools and API-only features do not carry over. Separate `reasoning_content`
fields are preserved as Vertex provider-data and replayed in tool history;
reasoning embedded by most hosts in text is retained
verbatim. Grok does not accept effort controls on Vertex. GPT OSS accepts
`low`, `medium`, or `high`; DeepSeek V3.1/V3.2, Gemma 4 and GLM 4.7/5/5.2 map effort to their
hosted thinking toggle (`none` disables it; `low`, `medium` and `high` enable the
same toggle). No direct-provider thinking contract is assumed.

GPT OSS accepts only `auto` or `none` tool choice on Vertex; required and named
choices are rejected locally. When tools are provided without a choice, GPT OSS
and Qwen requests explicitly use `auto`. This also prevents a current GPT OSS
host template error when `tool_choice` is omitted. Missing GPT OSS tool
descriptions are serialized as empty strings for its Harmony serializer. See Google's
[function-calling guidance](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/capabilities/function-calling).

Grok also exposes a separate Responses API on Vertex/global:

```ts
const grokResponses = createVertex({ location: "global" }).responsesModel("xai/grok-4.20-reasoning");
const answer = await generateText({ model: grokResponses, prompt: "Explain vector search briefly." });
```

This factory supports text/image input, streaming, callable tools and native JSON
Schema output. It uses Google bearer credentials, preserves Vertex provider-data
and replays conversation/tool history locally with `store: false`. Google does
not currently support `store: true` or `previous_response_id` on this route.
Use the shared `temperature`, `maxTokens`, `toolChoice` and `structuredOutput`
fields; the additional provider options are `top_p`, `parallel_tool_calls` and
`store: false`. Hosted tools, reasoning controls and arbitrary OpenAI options are
rejected before network access. `chatModel()` remains the Chat Completions route.
Live validation passed for `xai/grok-4.20-reasoning` on global: streaming, native
schema, a single-execution function loop and synthetic-invoice vision (JSON and
streaming). Other IDs and broader vision quality remain separately unverified. Reproduce with the live smoke
`--responses-only` flag and `VERTEX_INTEGRATION_MODEL=xai/grok-4.20-reasoning`.
For vision, use `bun scripts/vertex-vision-live-smoke.ts --responses` with ADC.
Local functions named `shell`, `computer` or `apply_patch` retain ordinary function
semantics. The internal OpenAI package supplies only the Responses wire parser;
requests go to Google, never to the OpenAI API.
Sources: [Responses](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/grok/responses),
[function calling](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/grok/capabilities/function-calling),
[structured output](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/grok/capabilities/structured-output).

For self-deployed models, `chatModel()` accepts an endpoint ID, `endpoints/<id>`
or full project/location endpoint resource. Supply `baseURL` and `apiVersion`
when using a dedicated prediction host or a deployment requiring `v1beta1`.
Deployment capabilities default conservatively and do not inherit hosted reasoning controls from a publisher-like model name. Native tool-choice, parallel-call and response-format options respect these capability restrictions. Explicitly enable the features
supported by your deployed model. This invokes an existing endpoint and does
not provision infrastructure.

Many older open-model MaaS IDs retire on October 21, 2026. Check Google's
[retirement schedule](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models)
before selecting one for a new workload; deployed endpoints are supported as a
migration path. Contract and SDK-consumer tests cover partner routes. Bounded
ADC checks also verified gpt-oss 120B streaming, native schema and a client tool
loop; those results do not certify all models or account entitlements.


### Implicit caching on managed open models

Vertex manages implicit context-cache hits on eligible MaaS models. This does
not use the explicit Google `cachedContents` resource client. Normalized usage
retains cache-read token counts from OpenAI-style `prompt_tokens_details` or
Vertex `cachedContentTokenCount`, including terminal streaming usage. Cache
hits remain service-dependent; see the [host's supported models and conditions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/use-open-models#context-caching).

### Routing publishers through the gateway

Register Vertex once; publisher-qualified model IDs remain within that host:

```ts
import { createGateway } from "@zhivex-ai/gateway";
import { createVertex } from "@zhivex-ai/vertex";

const vertex = createVertex({ projectId: "my-project", location: "global" });
const gateway = createGateway({
  adapters: { vertex },
  scoreTarget: ({ isPrimary }) => isPrimary ? 1 : 0,
});
const result = await gateway.generate({
  primary: { provider: "vertex", modelId: "meta/llama-4-maverick-17b-128e-instruct-maas" },
  fallbacks: [{ provider: "vertex", modelId: "claude-sonnet-4-6" }],
  messages: [{ role: "user", content: "Explain this delivery delay." }],
});
```

The explicit score keeps the primary first; the gateway's default scoring may
prefer a fallback model. Both destinations require access in your Google Cloud
project and must be available at the configured location. `providerUsed` remains
`vertex`; the model ID identifies the publisher. This example's cross-publisher
fallback is covered by offline SDK tests, not a live availability claim.

## Embedding configuration and specialized partner APIs

The shared `embed()` / `embedMany()` helpers forward `providerOptions` to Vertex.

E5 publisher embeddings use Google OAuth and the OpenMaaS embeddings endpoint:

```ts
const vertex = createVertex({ projectId: "my-project", location: "us-central1" });
const result = await vertex.embeddingModel("intfloat/multilingual-e5-small-maas")
  .embed({ values: ["query: available shipping methods", "passage: Express shipping takes two days."] });
```

The supported selectors are `intfloat/multilingual-e5-small-maas` and
`intfloat/multilingual-e5-large-instruct-maas`; publisher resource names are also
accepted. Supply the model's query/document formatting yourself: small uses
`query: ` and `passage: ` prefixes; large-instruct uses
`Instruct: <task description>\nQuery: <query>` for queries and plain documents.
See the [large-instruct model card](https://huggingface.co/intfloat/multilingual-e5-large-instruct).
These models
accept text and reject Google-specific embedding controls. Returned indices are
validated and vectors are restored to input order. Their MaaS retirement date is
October 21, 2026, recorded in the SDK catalog. Use a documented regional endpoint:
`us-central1` or `europe-west4`. Bounded ADC checks in `us-central1` returned
384 dimensions for small and 1,024 for large; the same small-model request on
`global` returned HTTP 500. The adapter preserves the caller's location and does
not silently move requests between regions. See the
[E5 model card](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/e5/multilingual-e5-small).
Legacy text models support `outputDimensionality`, `autoTruncate`, `taskType` and
`title` (retrieval documents only). Embedding 2 supports `outputDimensionality`,
`documentOcr` and `audioTrackExtraction` in `embedContentConfig`; text-only task
controls are rejected. Embedding 001 is sent one text at a time; other legacy text
models are split into batches of five, preserving order and aggregate token usage.
Google responses must match an explicitly requested `outputDimensionality`.
Google and E5 vectors must also have consistent dimensions across the entire
call, including split requests; malformed responses raise `ConfigurationError`.

```ts
const extracted = await vertex.ocr.process({
  modelId: "mistralai/mistral-ocr-2505",
  document: { uri: "https://example.com/report.pdf", mediaType: "application/pdf" },
  includeImages: false
});
const completion = await vertex.fim.generate({
  modelId: "codestral-2", prompt: "function answer() {", suffix: "}", maxTokens: 64
});
```

These Mistral clients require bearer credentials and model access in the selected
region. OCR accepts inline PDF/image data or HTTP(S) URLs and preserves page
metadata. FIM uses `rawPredict` / `streamRawPredict` with prompt and suffix.
The contract tests do not certify account access or every model revision.

### DeepSeek image extraction

```ts
const extraction = await vertex.ocr.process({
  modelId: "deepseek-ai/deepseek-ocr-maas",
  document: { uri: "https://example.com/invoice.png", mediaType: "image/png" },
  prompt: "Free OCR",
});
```

DeepSeek OCR uses the OpenMaaS chat transport with image input; the result represents
one input image as page index zero. PDF input, page selection and image extraction
options are rejected for this model. Rasterize a PDF before supplying an image,
with one call per page, or use Mistral OCR for PDF documents. Truncated or filtered
responses are rejected instead of being returned as a complete extraction.
The prompt defaults to `Free OCR`; Mistral OCR rejects this prompt option because
its document endpoint has a different contract. This facade has offline contract
coverage and successful OAuth transport, but a live synthetic invoice check
omitted its heading; OCR content verification is not yet passing. Mistral OCR
returned 404 in the test project at us-central1. Run the dedicated OCR smoke
against your enabled models before relying on extraction completeness. DeepSeek OCR MaaS retires on
October 21, 2026 according to the SDK catalog.

OCR and FIM reject reserved wire fields in `providerOptions` (such as `document`,
`messages`, `pages`, `prompt` or `suffix`) that conflict with their dedicated input
fields. Other native options remain available through `providerOptions`.

Live embedding checks also verified task type, disabled truncation and 256
dimensions on text-embedding-005, plus inline PNG input with 768 dimensions on
gemini-embedding-2. Additional bounded calls verified a one-page PDF with `documentOcr: true` and one-second WAV audio at 768 dimensions. A separate live check embedded one second of Google’s public highway video from GCS at 1 FPS with audio extraction disabled: 128 dimensions, unit norm and 66 input tokens. This verifies that configuration, not semantic retrieval quality or inline video. Reproduce with `bun scripts/vertex-video-embedding-live-smoke.ts` using ADC credentials. Embedding 2 advertises image, document and audio input capabilities; legacy Google and E5 models remain text-only.


### Legacy multimodal embeddings

Basic image/text retrieval at 128 dimensions passed live for this model and
Gemini Embedding 2 using the synthetic invoice fixture. Reproduce with
`bun scripts/vertex-image-retrieval-live-smoke.ts` and ADC credentials from the
repository root. This checks one matching description against two distractors;
it does not establish general multimodal retrieval quality.

`embeddingModel("multimodalembedding@001")` supports text and PNG/JPEG image
values, preserving one vector per input. Set `providerOptions.outputDimensionality`
to 128, 256, 512 or 1408. Each input uses its own native prediction request.
Google Cloud bearer credentials and a supported regional location are required.

For combined modalities or video, use the native client:

```ts
const result = await vertex.multimodalEmbeddings.embed({
  text: "A road with vehicles",
  video: { uri: "gs://my-bucket/road.mp4", mediaType: "video/mp4" },
  videoSegmentConfig: { startOffsetSec: 0, endOffsetSec: 8, intervalSec: 4 },
});
// result.textEmbedding: 1408 dimensions
// result.videoEmbeddings: individual 1408-dimensional vectors with
// startOffsetSec and endOffsetSec for every returned segment.
```

`outputDimensionality` is available for text/image-only requests. Any request
containing video uses 1408 dimensions and rejects that option locally, and the unified `embed` method directs video callers to the native client
so no segments are silently discarded. Media accepts inline bytes or `gs://`
object URIs. Video audio is not embedded by this model. No token usage is invented
when its response provides none. See the [native API reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/multimodal-embeddings-api).

## Virtual Try-On

```ts
const cloud = createVertex({ location: "us-central1" }); // Google Cloud ADC
const result = await cloud.virtualTryOn.generate({
  personImage: { uri: "gs://my-bucket/person.png", mediaType: "image/png" },
  productImage: { uri: "gs://my-bucket/shirt.jpg", mediaType: "image/jpeg" },
  count: 1,
  outputMimeType: "image/jpeg",
  providerOptions: { outputOptions: { compressionQuality: 85 } }
});
// result.images contains inline bytes or GCS URIs; result.filtered retains reasons.
```

This dedicated client calls `virtual-try-on-001:predict` using Google bearer
authentication. Person and product are named inputs, not positional chat images.
It supports PNG/JPEG as inline `data` or GCS `uri`, a product mask/configuration,
1–4 outputs, native prediction parameters and optional `outputStorageUri`.
Inline inputs are limited to 7 MiB each. Unknown/malformed image responses fail
explicitly; filtering reasons remain available even when no image is returned.
Shared deadlines, cancellation and retries apply through the prediction transport.
Use `virtualTryOn.generate()` instead of the Gemini language/image factories.
A bounded ADC smoke passed in `us-central1` with the two public images from
Google's notebook, returning one JPEG (311,148 bytes). This proves transport and
output-format behavior. A second ADC request with both images inline and
`outputOptions.compressionQuality:85` returned a valid JPEG (347,627 bytes).
Visual inspection of that example confirmed the blue V-neck sweater replaced
the hoodie while preserving the subject's pose and field background. This is
one inspected example, not a quality benchmark; masks remain unverified live.
Reproduce with `bun scripts/vertex-virtual-try-on-live-smoke.ts` and ADC configured;
add `--inline --save-artifacts` to exercise inline input and save the two public
fixtures and generated JPEG to a new local temporary directory for inspection.
It creates no persistent cloud resources.
See [Google's Virtual Try-On guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/generate-virtual-try-on-images).

## Vertex Interactions (experimental)

```ts
const vertex = createVertex({ projectId: "my-project", location: "global", getAccessToken });
const music = await vertex.interactions.create({
  modelId: "lyria-3-clip-preview", input: "A short instrumental jazz piece", store: false
});
// Consume music.outputs directly; this Lyria route does not support storage.
```

Lyria 3 Clip requires `store: false` on the tested Vertex route; the adapter sends
that default explicitly and rejects `store: true`. Do not use its returned ID as
proof of stored retrieval or resumption. Other model/agent storage options retain
their own contracts.

Interactions model availability is separate from `generateContent`: a live call
with `gemini-3.7-flash` was rejected as unsupported. The Vertex reference names
Lyria 3 and Deep Research, while the video guides document Gemini Omni. Choose
a model or agent explicitly supported by this API. Multiple model-output steps
are preserved, including Lyria lyrics, captions and audio.

The client uses the project-scoped `v1beta1` Interactions endpoint and supports
create/get/list/cancel/delete, streaming and resumption with `lastEventId`. Streaming
preserves native events, event IDs and multimedia blocks as `provider-data`, in
addition to normalized text, tool calls and terminal status. Interrupted streams
throw instead of reporting successful completion. `cancel()` targets background interactions using the project-scoped
`interactions/{id}/cancel` route verified in the official Google Gen AI SDK.

Live validation passed for stored Omni 1.1 background video: close the initial
stream, resume the same ID using its cursor, retrieve completed outputs and
delete the interaction (absence verified with HTTP 404). A background GET stream
may exhaust currently available events before completion; the client raises its
missing-terminal error. Retain the latest cursor and observe that same interaction
again with an application deadline instead of creating another generation.
The bounded smoke demonstrates this flow:
`VERTEX_INTERACTIONS_RESUME_MODEL=gemini-omni-1.1-flash-preview bun scripts/vertex-interactions-resume-live-smoke.ts`
with ADC configured. Its native video settings are 3 seconds and 360p, and it
cleans up the owned interaction. Mid-tool-argument recovery remains covered by
contract tests, not this video smoke.

For text resumption, persist the interaction ID and the latest delivered
`provider-data.data.event_id` together with the output already consumed, then
call `resume({ id, lastEventId })`. Keep event IDs opaque: pass the original value;
the client encodes the query parameter. It does not persist application output or
automatically replay an interrupted stream. Contract tests cover a text stream
ending before its terminal event and resuming without duplicating prior text.
To resume during tool arguments, also pass `previousEvents`: the ordered native
Vertex event objects already consumed, ending at the event whose `event_id`
exactly matches `lastEventId`. Include all prior tool start/delta/stop events so
pending arguments and completed-call IDs can be reconstructed. The history is
used locally and never sent to Google; prior text, metadata and completed tool
calls are not emitted again. Limits are 16,384 events and 8 MiB of serialized
history, with the existing per-call argument bounds. `VertexInteractionResumeInput`
is exported for typed consumers. Persist cursors together with application output
and tool execution state; this API does not provide durable exactly-once execution.

`musicGenerationModel("lyria-3-clip-preview")` and Lyria 3 Pro route synchronous
music generation through Interactions, including optional image input. Native
asynchronous workflows should use `interactions` directly. Model access, location,
preview availability and billing remain governed by Google Cloud. Bounded ADC
checks verified Lyria 3 Clip creation and streaming on global, including text,
inline MP3 audio and successful terminal status. Persistence, resumption, Pro
and other model/agent variants require separate live verification.

Hosted tools use the Interactions contract: Google Maps maps `enableWidget` to
`enable_widget`, and `vertexSearch` accepts native `engine`/`datastores` config
and maps to Vertex AI Search retrieval. Native `retrieval` config can also be
supplied. Gemini Developer File Search is rejected on this Vertex route.
Callable tool streams accept the documented `arguments_delta` discriminator.

References: [Vertex Interactions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api),
[Lyria music generation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/music/generate-music),
[Mistral on Vertex](https://docs.mistral.ai/inference/deployment/cloud-deployments/vertex).


## Vertex Live transport

Buffered transcription and speech generation, plus speech stream setup, honor
configured HTTP retries with deadline-bound backoff. Once a speech stream delivers
audio, parsing or transport failures propagate without replaying the response.
This HTTP speech behavior is separate from Live WebSocket reconnection.

The connection `timeoutMs` includes credential acquisition. The transport receives
the remaining time after ADC or a custom token resolver returns. Cancellation
while waiting for credentials prevents a later WebSocket connection. The original
caller signal is retained for transport/session cancellation; the temporary
credential deadline does not abort an established session.

Native tool cancellations emit `realtime-tool-call-cancellation` with
`toolCallIds`. Callback sessions reject results for those IDs and suppress
cancelled call replays. `session.toolCallSignal(id)` aborts independently of event
consumption. `streamLiveAgent` uses it to stop approval waits and signal running
executors through `context.abortSignal`, then continues the conversation. Custom
session implementations must expose this optional method for the same behavior.
Executors must cooperate with abort; already-applied side effects are not undone.
An interrupted durable execution retains its indeterminate `running` journal entry.

For explicit `session.interrupt()`, connect with
`providerOptions: { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } }`.
The method sends a manual activity start/end pair and preserves the connection.
With automatic VAD enabled, speech drives interruptions; calling `interrupt()`
in that mode fails locally. Dedicated Live Translate rejects this operation.
Clients must still discard queued playback when they receive an interrupted event.

`session.sendMedia()` sends visual frames as native `realtimeInput.mediaChunks`.
Supply discrete image frames, rather than a video container. The synthetic invoice reading smoke passed with a one-second gap before the
text question. Immediate image/text sends completed but misread the amount;
applications must account for realtime media processing and turn ordering.

Dedicated Live Translate sends `generationConfig.translationConfig`, with
`translation.targetLanguage` and optional
`providerOptions.translationConfig.echoTargetLanguage`. Source language is
detected automatically; explicit `translation.sourceLanguage` is rejected.
Output transcription requests AUDIO and TEXT, matching Google's introductory
notebook. Use `session.setInputMuted(true)` after the final audio chunk to send
`audioStreamEnd`; unmuting allows subsequent audio input.
Use location `global`; other standard regions fail locally for this model.
The corrected setup is accepted and one bounded live probe received audio,
but translation text and completion are not yet live-certified. A subsequent
v1beta1 probe returned a quota-exceeded message inside a text part instead of
translation output. Diagnostics report this separately from protocol failures.
See the maintainer smoke guide for the reproducible `--translate` check.

`session.update({ instructions: "New instructions" })` sends a system-content
update without starting a response. Other configuration changes require a new
connection and are rejected locally. Repeating the same instructions or sending
an empty update is a no-op; removing instructions requires reconnecting.

Enable resumption with `providerOptions: { sessionResumption: {} }` when
connecting. Save handles only from `realtime-session-resumption` events with
`resumable: true`, then reconnect with
`providerOptions: { sessionResumption: { handle } }`. Reconnection is managed by
the caller. A `realtime-go-away` event exposes `timeLeftMs` when the server
announces impending closure. A `realtime-response-complete` event with
`reason: "interrupted"` signals that playback should stop and queued audio
should be discarded; a subsequent `turn-complete` can still follow.

Live sessions use a full `projects/.../locations/.../publishers/google/models/...`
model resource and OAuth bearer headers. Node and Bun use the shared authenticated
WebSocket transport by default. Other runtimes can supply a `realtimeConnectionFactory`;
the browser transport cannot attach bearer headers. The project scope comes from `baseURL` when it
contains a project/location resource, otherwise from the provider project and
location. The live smoke uses `ws` with a bounded queue and validates a synthetic
text turn, audio output and transcription in `us-central1`.

Live callable tools arrive as native `toolCall.functionCalls` messages and are
normalized to `realtime-tool-call` events. Send results with `sendToolResult()`
using the received call ID. `generation-complete` can precede a tool follow-up;
a tool-only turn may also complete without audio. When collecting a spoken tool
response, wait for the subsequent `turn-complete` with audio after the tool result.

## Grounded generation

`groundedLanguageModel()` uses Google Search and returns source URLs, normalized
`usage`, and the original response containing grounding supports and search
entry-point metadata. Retryable HTTP errors respect `maxRetries` and the overall
request deadline. A live `gemini-3.7-flash` check returned seven sources and
attribution supports; reproduce with `bun scripts/vertex-grounding-live-smoke.ts`
using ADC. The separate Maps smoke also passed; private Vertex AI Search still
requires a configured test datastore and separate validation.

Gemini generation and stream setup honor `maxRetries` for retryable HTTP errors.
`timeoutMs` bounds the request including retry backoff. Once a stream starts
delivering output, subsequent stream errors propagate without automatic replay.

Google Maps coordinates must be finite, with latitude within [-90, 90] and longitude
within [-180, 180]; `enableWidget` must be boolean. Invalid configurations fail
before sending a request. `bun scripts/vertex-maps-live-smoke.ts` checks place
sources and attribution metadata. The latest live check on gemini-3.7-flash/global
passed with two Maps places and four attribution supports. An earlier 429 was
transient in the tested project; availability elsewhere is not implied.

## Context caching

Cache creation and deletion honor explicit `maxRetries`, with backoff bounded by
`timeoutMs`; retries are disabled by default. Creation has no deduplication key,
so an uncertain result can require reconciliation before retrying. Deletion
accepts HTTP 204 and preserves 404 as an error rather than claiming it performed
the deletion. A separate GET 404 can establish resource absence during cleanup.

```ts
import { updateContextCache } from "@zhivex-ai/core";

await updateContextCache({ provider: vertex, name: cache.name, ttl: "3600s" });
// Alternatively set expireTime to an RFC 3339 timestamp; do not set both.
```

The helper is also exported by `@zhivex-ai/sdk`. The direct
`vertex.caches.update()` method remains available. Other providers without this
optional operation throw `UnsupportedFeatureError` through the helper.

Context-cache `get()` and `list()` honor `maxRetries` for transient HTTP failures;
`timeoutMs` also bounds their retry backoff. Pagination tokens remain unchanged
across attempts.

The context-cache lifecycle smoke is `bun scripts/vertex-cache-live-smoke.ts --gcs`.
It uses Google's public sample PDF plus a synthetic verification code, a short
TTL and cleanup. The live run passed creation, read, expiration update, code
retrieval, nonzero cached-token usage and deletion confirmed by a subsequent 404.
Use `--diverse-text` instead of `--gcs` for the verified synthetic text lifecycle,
which also passed both `expireTime` and `ttl` updates. The default repetitive
text fixture still has an unresolved creation error.
For uncertain creation outcomes, use
`bun scripts/vertex-cache-reconcile-smoke.ts <state-file>` to enumerate caches and
remove only the uniquely named smoke resource.

When creating a context cache, set either `ttl` or `expireTime`. Supply model,
contents, system instructions, tools, display name and expiry through their
dedicated fields; conflicting `providerOptions` fail locally. Other native
options, such as `kmsKeyName`, are preserved.

Cache creation accepts bare Google model IDs, `publishers/google/models/<id>` and
fully qualified project model resources. The repetitive-text live follow-up reached HTTP
with 28,752 text characters but received a one-token/minimum-size error from
Vertex. That discrepancy remains under investigation. Both varied text and GCS
PDF lifecycles passed on gemini-2.5-flash/us-central1; other model and region
combinations remain unverified.

For cache encryption, `providerOptions.kmsKeyName` is a convenience field mapped
to the REST `encryptionSpec.kmsKeyName` object. You can instead pass native
`providerOptions.encryptionSpec`; supplying both forms is rejected. The KMS key
must be a full `projects/.../locations/.../keyRings/.../cryptoKeys/...` resource.
This mapping has contract coverage; use with an actual KMS key remains unverified.

## Gemini token counting

```ts
const count = await vertex.gemini.countTokens({
  modelId: "gemini-2.5-flash",
  messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
  timeoutMs: 15_000,
});
console.log(count.inputTokens);
```

The client accepts system instructions, SDK tools, multimodal message parts and
native `generationConfig`. It returns validated `inputTokens`, optional
`totalBillableCharacters` and `rawResponse`. Claude uses the separate
`vertex.claude.countTokens()` native message contract. Token counting does not
create a cache or prove that a subsequent cache creation will succeed.

## Dedicated audio transcription

Use `transcriptionModel("gemini-3.5-transcribe-preview")` with bearer credentials
and `location: "global"` for recorded audio. The adapter sends audio-only contents
and native recognition configuration; `prompt` is rejected for this model.

Dedicated Transcribe and Live Translate models reject `vertex(modelId)`,
`languageModel()` and `groundedLanguageModel()` locally. Use the transcription
factory above or `realtimeModel()` for Live variants. Transcription and speech
capabilities describe those audio adapters: they do not advertise chat tools,
vision, grounding, URL context, cache, batch or endpoint prediction operations.
Provider-level resource clients remain separate surfaces.

```ts
const result = await vertex.transcriptionModel("gemini-3.5-transcribe-preview").transcribe({
  audio: { data: audioBytes, mediaType: "audio/wav" },
  language: "en-US",
  providerOptions: {
    audioTranscriptionConfig: {
      customVocabulary: ["Zhivex"],
      wordTimestamp: true,
      diarization: true,
      mode: "VERBATIM"
    }
  },
  timeoutMs: 45_000
});
console.log(result.text);
for (const part of result.transcriptions) {
  console.log(part.speakerLabel, part.languageCode, part.words);
}
```

`text` combines all response fragments. Native `transcriptions` preserve speaker
labels, language codes and word offsets as duration strings; `rawResponse`
retains the original response. The shared `transcribeAudio()` helper exposes its
shared result contract; use the provider model directly for typed native details.
`language` maps to `languageCodes`; conflicting hints fail before sending.
`SMART` mode cannot combine with `wordTimestamp` or `diarization`, and custom
vocabulary accepts up to 1,000 nonempty terms. Existing Gemini audio-understanding
models retain prompted transcription behavior.

One live v1/global check passed synthetic speech and word timestamps. Diarization,
SMART formatting and custom vocabulary quality remain unverified. The
synchronous factory rejects the separate Live model. See [Google's transcription guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-transcribe).

### Live transcription

Use `realtimeModel("gemini-3.5-transcribe-live-preview")` on global with bearer
authentication. The session waits for setup acknowledgement before accepting
audio. It requests text output and defaults to input transcription enabled.

```ts
const session = await vertex.realtimeModel!("gemini-3.5-transcribe-live-preview").connect({
  mode: "transcription",
  inputAudioTranscription: { languageCodes: ["en-US"], customVocabulary: ["Zhivex"] }
}, { timeoutMs: 15_000 });
try {
  await session.sendAudio({ data: pcmBytes, mediaType: "audio/pcm;rate=16000" });
  await session.setInputMuted(true);
  for await (const event of session.eventStream()) {
    if (event.type === "realtime-provider-data") console.log(event.data);
    if (event.type === "realtime-transcript" && event.isFinal) {
      console.log(event.text);
      break;
    }
  }
} finally {
  await session.close();
}
```

Interim hypotheses arrive as `realtime-provider-data` with
`data.type: "vertex_transcription_interim"` and the native `transcription` object.
They replace the previous hypothesis; do not append them as text deltas. Final
segments arrive as `realtime-transcript`, `role: "user"`, `isFinal: true`.
Native metadata remains available on the events.

`setInputMuted(true)` sends `audioStreamEnd` once and discards subsequent audio
frames while muted. `setInputMuted(false)` permits audio for the next segment.
This model produces no generated audio and rejects text/image input, tools,
system instructions, reasoning, word timestamps and diarization. Shared
`inputTranscription.language` maps to native language hints. Native language
codes, custom vocabulary and VERBATIM/SMART modes are accepted; quality depends
on the selected language and audio.

A bounded real v1/global session passed with three interim hypotheses and a
final hello-world transcript, without generated audio. Run
`bun scripts/vertex-transcription-realtime-smoke.ts` for the owned audio fixture.

## Verification and remaining limits

Live results are scoped to the tested model, location and project. The
[readiness summary](../../docs/maintainers/VERTEX_READINESS.md) separates
implementation, external blockers, quality evaluation and delivery status.

| Area | Verification evidence | Remaining limitations |
| --- | --- | --- |
| Gemini and partners | Gemini text/tools/stream/schema; GPT OSS, Gemma 4, DeepSeek V3.2, Kimi K2 and MiniMax M2 tool loop/stream/schema; Qwen3-Next Instruct schema | Other models need separate checks; Claude returns 429, Llama 4 Scout returns 404 in us-east5 |
| Embeddings | Google text and selected media, including inline/GCS video with audio extraction; regional E5 vectors; basic text retrieval for Google and both E5 variants | No broad quality benchmark; additional media retrieval remains unverified |
| Google caches | Varied text and public PDF create/read/use/delete; ttl and expireTime updates | Repetitive-text fixture error unresolved; real CMEK unverified |
| Google batch | GCS output and separate cancellation; job/bucket removal confirmed by 404 | BigQuery API is disabled in the test project; partner batch unverified |
| Grounding | Google Search and Maps sources and attribution | Private Search needs a test datastore |
| Specialized APIs | Lyria 3 Clip and Omni video | OCR content/access, Codestral and additional Interactions workflows remain pending |
| Live | Audio, tools, resume, instruction update and interruption | Tool cancellation and dedicated translation lack live certification |
| Deployed endpoints | Contracts and installed Node/Bun local TLS tests; real Google gRPC auth reached a missing-resource error | Successful inference requires a real deployment and schema; none found in global/us-central1 |

Gemma 4 additionally passed image-based invoice extraction with native schema
and streaming on global. The test uses a repository-owned synthetic PNG and
asserts its amount/currency without putting the answers in the prompt or schema.
Run `bun scripts/vertex-vision-live-smoke.ts` with ADC. This is one fixture, not
a broad OCR quality benchmark.

Gemma 4 and DeepSeek V3.2 additionally passed explicit thinking on/off and
streamed reasoning checks on global. Reasoning remains in Vertex provider-data
parts, separate from answer text. Run `bun scripts/vertex-reasoning-live-smoke.ts`
with either exact model ID as its argument; the script prints counts, not reasoning
content. GLM thinking toggle mapping has contract tests; live access is unresolved.

MiniMax M2 now passes streaming, native schema and tool-loop checks. Its documented
leading `<think>` envelope is separated from answer text into Vertex provider-data
with `type: "vertex_inline_thinking"` and the exact envelope in `content`.
Subsequent assistant history restores that envelope for the host. Streaming
supports split delimiters; literal tags within answer text remain unchanged.
Incomplete envelopes and envelopes exceeding 1,048,576 characters raise an error.
This normalization applies only to managed `minimaxai/minimax-m2-maas`, not to
custom deployments or arbitrary model IDs.

Publisher checks are operation-specific. In the current test project, GLM 5.2
returned 429 for all three chat scenarios, Qwen3-Next Instruct passed native schema
but returned 429 for streaming/tools, and Grok 4.3 returned 404 on global.
Mistral Medium 3 and Small 2503 also returned 404 in us-central1; Google reported
NOT_FOUND and an ambiguous missing-model/access message for Small. Verify model
enablement and project access in Model Garden before attempting certification.
These statuses do not establish a permanent model limitation. The implementation
ledger records exact IDs and locations; successful calls do not override catalog
retirement dates or certify untested vision/reasoning features.

Repository smoke commands require configured credentials and can incur usage.
Use `VERTEX_INTEGRATION_USE_ADC=1` and remove API-key/token environment overrides
when selecting ADC. No access token needs to be pasted into source code.

| Check | Command from the repository root |
| --- | --- |
| Selected MaaS chat | `bun scripts/vertex-live-smoke.ts --chat-only` (set `VERTEX_INTEGRATION_MODEL` and `VERTEX_LOCATION`) |
| Claude generation/counting | `bun scripts/vertex-claude-live-smoke.ts` |
| Text retrieval | `bun scripts/vertex-retrieval-live-smoke.ts` |
| Inline video embeddings | `bun scripts/vertex-video-embedding-live-smoke.ts --inline` |
| Video audio extraction | `bun scripts/vertex-video-embedding-live-smoke.ts --extract-audio` (add `--inline` for inline bytes) |
| Cache lifecycle | `bun scripts/vertex-cache-live-smoke.ts --diverse-text` or `--gcs` |
| Batch lifecycle | `bun scripts/vertex-batch-live-smoke.ts start STATE_FILE`, then `status`, `cancel`, `cleanup`, or `verify-cleanup` with the same state file |

E5 small retrieval uses explicit `query: ` and `passage: ` prefixes supplied by
the caller. The retrieval smoke checks a tiny synthetic corpus, not model quality.
Batch cancellation is complete only after a GET reports JOB_STATE_CANCELLED;
a successful cancel request alone does not establish that terminal state.

The SDK-owned catalog now includes partner and specialized model IDs. Optional
`entry.lifecycle` carries source-backed deprecation and retirement dates. It is
snapshot metadata, not a live availability check or proof of account access;
the frozen legacy core catalog remains unchanged.

The generated [catalog and adapter matrix](../../docs/maintainers/VERTEX_CATALOG_MATRIX.md)
lists all 62 inventory entries with their selected factory, lifecycle and declared
capabilities. It is an offline contract audit; use the live evidence table above
to assess validation of a specific route.


For local artifact validation, run `bun run build` followed by
`bun run scripts/vertex-package-smoke.ts`. The latter installs the unreleased
local package cohort into an isolated consumer and uses synthetic responses;
release dependency resolution and live model access are separate checks.

Repository: <https://github.com/Zhivex/zhivex-ai-sdk>
