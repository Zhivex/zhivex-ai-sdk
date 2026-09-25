# @zhivex-ai/vertex

## 1.1.2

### Patch Changes

- Updated dependencies [be12ce8]
- Updated dependencies [29ae47c]
- Updated dependencies [29ae47c]
- Updated dependencies [9e5715a]
- Updated dependencies [29ae47c]
  - @zhivex-ai/core@1.24.0
  - @zhivex-ai/anthropic@0.12.3
  - @zhivex-ai/openai@0.13.6

## 1.1.2-next.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.24.0-next.0
  - @zhivex-ai/anthropic@0.12.3-next.0
  - @zhivex-ai/openai@0.13.6-next.0

## 1.1.1

### Patch Changes

- e3f1444: Preserve Responses function results named apply_patch, shell, or computer. Select native output protocols from explicit call/result metadata rather than tool names, reject conflicting metadata, and retain receipt payloads across persisted and stateless continuations.
  
  Remove the obsolete Vertex Responses tool-name workaround so canonical call/result names remain consistent.
- Updated dependencies [f35fafe]
- Updated dependencies [4f51d78]
- Updated dependencies [e705a21]
- Updated dependencies [e3f1444]
  - @zhivex-ai/core@1.23.0
  - @zhivex-ai/openai@0.13.5
  - @zhivex-ai/anthropic@0.12.2

## 1.1.1-next.1

### Patch Changes

- Preserve Responses function results named apply_patch, shell, or computer. Select native output protocols from explicit call/result metadata rather than tool names, reject conflicting metadata, and retain receipt payloads across persisted and stateless continuations.
  
  Remove the obsolete Vertex Responses tool-name workaround so canonical call/result names remain consistent.
- Updated dependencies
  - @zhivex-ai/openai@0.13.5-next.1

## 1.1.1-next.0

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.23.0-next.0
  - @zhivex-ai/anthropic@0.12.2-next.0
  - @zhivex-ai/openai@0.13.5-next.0

## 1.1.0

### Minor Changes

- Add the optional context-cache expiration update contract and implement Vertex cache PATCH with explicit field masks, expiry validation, retries and deadlines.
- Support Claude browser toolset declarations and preserve toolset identity in generated/streamed calls and replayed results. Allow native browser result blocks through the shared Anthropic transport. Vertex enables the browser toolset only on supported models.
- Expose source-backed model lifecycle metadata and expand the SDK Vertex catalog to partner chat and specialized models. Enable supported Claude native tools on Vertex, prompt-cache TTL validation and session affinity, while rejecting unsupported image/document sources and beta features locally.

  Enable Vertex-supported automatic Claude compaction and context editing with body beta flags and strategy validation; keep direct-only on-demand compaction rejected.

  Add a dedicated claude.countTokens client with native Claude message blocks, tools and system inputs, OAuth/location guards, bounded responses and normalized input-token counts.
- Support Gemini 3.5 Transcribe with native language hints, vocabulary, timestamps, diarization and formatting configuration. Preserve complete transcript text and typed native word/speaker details. Add the synchronous model to the Vertex catalog and reject incompatible configuration and Live-model use in the synchronous factory.

  Support the dedicated Live Transcribe model with text-only setup, recognition options, replaceable interim hypotheses, final user transcripts and audio-stream-end/mute handling. Add its catalog entry and reject unsupported conversation controls.
- Add native endpoints.rawPredict and endpoints.streamRawPredict clients for arbitrary text/binary HTTP payloads, bounded binary responses, cancellable streaming and deployed-model response metadata.

  Add endpoints.directRawPredict for serialized gRPC request/response messages over Vertex's REST bridge, including base64 encoding and bounded decoding.

  Expose endpoints.explain with native configuration overrides, predictions and per-instance explanations.

  Expose endpoints.directPredict with typed native REST tensors, precision-preserving 64-bit integer fields and bounded responses.

  Add bidirectional endpoints.streamDirectPredict and endpoints.streamDirectRawPredict using the official Google gRPC client, with cancellation, bounded responses and typed tensor conversion.

  Keep bidirectional gRPC cancellation and deadlines responsive while synchronous input sources continuously supply messages.

  Expose the separate bidirectional streamingPredict and streamingRawPredict RPCs with the same bounded, cancellable tensor and byte contracts.

  Expose serverStreamingPredict with a single typed tensor request, streamed tensor responses, cumulative limits and cancellation.

  Support publisher model resources on serverStreamingPredict and preserve unescaped resource identifiers in gRPC protobuf requests.
- Expose gemini.countTokens with mapped messages, system instructions, tools and native generation configuration. Return validated token and billable-character counts, with bounded retries and request deadlines.
- Add `responsesModel()` for Grok on Vertex/global with Google authentication,
  streaming, function tool loops and native structured output. Preserve Vertex
  provider-data and stateless history; reject unsupported storage, continuation,
  hosted-tool and reasoning controls. Reuse the internal OpenAI Responses transport
  without inheriting its provider-specific API defaults.
- Add optional local previousEvents history to Vertex Interactions resume, restoring
  partial tool arguments and duplicate-call guards without re-emitting previously
  consumed output. Export VertexInteractionResumeInput and validate history/cursor
  consistency before issuing requests.
- Support multimodalembedding@001 text and image embeddings through the unified embedding factory. Add a native multimodalEmbeddings client for combined text/image/video requests, preserving video segment timestamps and individual vectors. Include the model in the Vertex catalog.
- Correct Vertex jurisdictional US/EU hosts, Gemini Embedding 2 multimodal requests, and native batchPredictionJobs lifecycle with Cloud Storage and BigQuery input/output. Resolve full cache/job resource names correctly and support prediction against self-deployed endpoint resources. Vertex batch jobs require bearer credentials; Gemini Developer API files and inline batch requests are rejected locally.

  Resolve publisher/model selectors for partner batches and raw prediction. Retry transient batch HTTP errors inside the retry boundary, preserving cancellation and nonretryable error behavior.

  Fix Vertex Live setup to send the full project/location/publisher model resource instead of the Gemini Developer API models path.

  Decode Vertex Live native toolCall.functionCalls events, preserving IDs for correlated tool responses and rejecting malformed or duplicate calls.
- Add a host-neutral Chat Completions transport with tool history, schema output, streaming, reasoning metadata, bounded tool arguments, cancellation and HTTP retries. Expose it as a Beta provider-construction helper.

  Route Vertex publisher/model selectors through Google-authenticated Chat Completions or publisher raw prediction, preserving Vertex provider identity and host-specific reasoning controls. Add explicit chatModel selection for self-deployed endpoints with deployment capability overrides.

  Reject partner selectors on Google-specific factories and include current GLM 5.2, Gemma 4, Llama 4 and gpt-oss 120B MaaS entries in the SDK catalog without inheriting other models' retirement dates or pricing.

  Default GPT OSS and Qwen tool requests to explicit auto choice. Reject GPT OSS required/named choices unsupported by Vertex; this fixes the live host template error when a GPT OSS tool request omits tool_choice.

  Normalize omitted GPT OSS tool descriptions to an empty string, as required by the Vertex Harmony serializer.

  Map required tool choice to the native Mistral publisher value any without changing other publishers.

  Keep self-deployed reasoning capabilities independent of hosted model names. Enforce Chat Completions capability restrictions for native tool-choice, parallel-call and response-format options and streaming. Record Jamba 1.5 retirement metadata in the Vertex catalog.

  Select hosted chat capabilities and thinking controls from exact model profiles instead of publisher/name prefixes. Unknown IDs retain text transport without advertising unverified advanced capabilities.
- Forward provider-specific embedding controls through the shared embedding API. Add Vertex embedding model validation and batching, Mistral OCR and Codestral FIM clients, and project-scoped Interactions with resumable streaming, metadata listing and Lyria 3 music generation. Export shared document extraction and text completion input types.

  Route E5 publisher embeddings through the bearer-authenticated OpenMaaS embeddings endpoint, validating vector indices and preserving input order.

  Add prompt-based DeepSeek image extraction to Vertex OCR, reject incomplete extractions and conflicting native options, and validate specialized sampling inputs and OCR page identities.

  Reject duplicate Interactions tool identifiers and indices, validate completed tool arguments, and stop/cancel the response after a terminal streaming event.

  Expose the always-present Vertex embeddingModel factory as required in the returned TypeScript type.

  Preserve all Interactions model-output steps so Lyria lyrics and captions are not discarded when the final step contains audio.

  Decode the documented Interactions arguments_delta events and normalize hosted Maps and Vertex Search tools to google_maps and retrieval. Reject unsupported hosted tool types, including Developer API File Search.

  Route Gemini Omni video models through Interactions with text/image input, inline or GCS output, model-specific resolution validation and catalog entries. Preserve Veo prediction-operation routing.

  Advertise image, document and audio input capabilities on Gemini Embedding 2, while preserving text-only capabilities on legacy and E5 embedding models.
- Add a native `virtualTryOn.generate()` client with named person/product images,
  inline and GCS input, masks and native options, normalized image output and
  filtering reasons. Include Virtual Try-On in the Vertex catalog and reject
  routing this specialized model through Gemini generation factories.

### Patch Changes

- Honor HTTP retries and deadline-bound backoff for transcription, speech generation and speech stream setup without replaying partially consumed audio streams.
- Bound HTTP credential acquisition by the request abort signal and deadline. Tokens arriving after cancellation no longer trigger an outbound request.
- Reject conflicting batch fileName/inputConfig sources and incomplete BigQuery input table URIs before creating a job.
- Map context-cache kmsKeyName configuration into the native encryptionSpec object. Reject malformed key names and conflicting encryption aliases; preserve native encryptionSpec input.
- Reject conflicting context-cache expiry fields and native options that override dedicated cache inputs. Preserve other provider options, including encryption configuration.
- Accept publisher-prefixed Google model IDs when creating context caches without duplicating the publisher path. Preserve fully qualified model resources.
- Honor explicitly configured HTTP retries for cache creation and deletion, bounded by the request deadline. Preserve delete 204 success and 404 errors.
- Retry transient HTTP errors when reading or listing context caches, respecting the overall request deadline and preserving pagination.
- Convert callable tool schemas to the supported Vertex parameter schema before sending requests. Strip unsupported JSON Schema metadata and additionalProperties recursively, preventing HTTP 400 errors during agent tool calls while retaining local input validation.
- Stop advertising inherited chat-only operations on transcription and speech adapters. Reject dedicated Transcribe and Live Translate models in language and grounded-language factories with guidance to use their audio factory instead.
- Reject Google embedding responses that do not match requested dimensions and
  Google/E5 batches with inconsistent vector lengths, including split requests.
- Reject malformed embedding token counts and unsafe aggregate totals rather than returning invalid usage to consumers. Apply safe-integer validation to Google and E5 responses.
- Honor retryable HTTP statuses for Gemini generation and initial streaming requests. Bound backoff by the request deadline and release timeout resources on streaming setup failure. Never replay a stream after partial output.
- Map unified reasoning controls for Vertex GLM 4.7, 5 and 5.2 to the documented
  enable_thinking template option. The none effort disables thinking; low, medium
  and high enable it without claiming distinct effort levels.
- Return normalized token usage from grounded generation and retry retryable HTTP errors within the request deadline.
- Correct Imagen output MIME mapping to `parameters.outputOptions.mimeType` and
  send canonical Vertex generation parameters without redundant snake-case aliases.
  Preserve native JPEG compression options, reject conflicting output formats,
  and reject unsupported reference-image input instead of silently dropping it.
- Include credential acquisition in the Vertex Live transport connection deadline and prevent late credentials from opening sockets after cancellation.
- Implement explicit interruption of Vertex Live conversation generation through manual activity signals. Require automatic activity detection to be disabled and reject the operation for the dedicated translation model.
- Surface Live response interruptions and clear interrupted transcript accumulation. Parse native GoAway protobuf durations into milliseconds so clients can act on impending connection closure.
- Pass the previous session configuration to realtime update callbacks. Vertex Live now updates instructions through system client content instead of resending setup, and rejects immutable configuration changes before sending them.
- Expose realtime tool-call cancellation events with correlated IDs. Vertex maps native cancellation messages; callback sessions suppress cancelled call replays and reject late results locally while retaining the connection. Live agents propagate per-call cancellation to approval waits and tool execution through an optional session signal, retaining indeterminate durable claims when effects may still be running. This does not undo local tool side effects.
- Send Live translation configuration inside generationConfig, matching Google's native WebSocket contract. Reject unsupported explicit source-language selection instead of sending an unrecognized sourceLanguageCode field. Request AUDIO and TEXT when output transcription is enabled, and support input muting to signal audioStreamEnd for translation sessions.

  Enforce the documented global region for dedicated Live Translate models, with the existing custom baseURL override preserved.
- Send Live visual frames through the native realtimeInput.mediaChunks field. The previous media field was a client-SDK argument rather than a valid WebSocket field and caused the service to close the session.
- Send store:false explicitly for Lyria 3 Clip interactions and reject store:true
  locally, matching the verified Vertex route restriction. Keep storage options
  for other models and agents unchanged.
- Validate Google Maps coordinate ranges and finite values, and reject non-boolean widget configuration before sending a request.
- Honor configured HTTP retries and deadline-bound backoff for native image, music, video generation and video operation polling. Poll retries preserve the existing operation.
- Separate MiniMax M2's leading inline thinking envelope from answer text in
  generation and streaming, fixing native structured output. Preserve the envelope
  as Vertex provider data and restore it in subsequent assistant history. Reject
  incomplete or oversized envelopes without altering other models or deployments.
- Reject partner batch creation on the unsupported global endpoint with an actionable regional configuration error before making a request.
- Separate Jamba JSON mode from unverified native JSON-schema output and reject streaming tool requests. Reject the unsupported Mistral safe_prompt option on managed Vertex routes while preserving custom deployed endpoint options.
- Honor configured HTTP retries and bound backoff by the deadline for native Vertex prediction and operation polling methods.
- Keep the native prediction action selector out of generated request bodies and reject provider options that override dedicated inputs or operation identity. Explicit raw bodies remain unchanged.
- Share the authenticated Node/Bun WebSocket transport through core. Vertex Live now connects with OAuth headers without a custom factory; Qwen reuses the same implementation. Keep browser transport selection separate, disable redirects, and handle handshake cancellation/timeout errors without unhandled socket events.
- Allow Gemini to answer after a forced Vertex tool call completes, while preserving explicit tool disabling. Correct the Kimi Thinking publisher identifier and DeepSeek OCR capability flags. Keep the earlier Kimi publisher spelling as a normalized alias.

  Enable documented DeepSeek R1-0528 function calling and disable the reasoning flag for Grok non-reasoning variants. Add the Vertex-hosted Grok catalog entries with explicit Grok 4.1 retirement metadata.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.21.0
  - @zhivex-ai/anthropic@0.12.0

## 1.0.2

### Patch Changes

- Add focused Core agent, generation, provider-helper, and catalog entrypoints. Migrate the Agents root, SDK runtime/catalog, and provider helper imports away from the complete Core aggregation while preserving existing public exports. Qwen also uses the focused provider helpers while retaining its multimodal and realtime behavior.

  Separate agent, workflow, and artifact persistence backends and the file generation cache into internal modules without changing schemas, key formats, leases, approvals, or backend behavior. Keep the legacy Core catalog frozen and compatible.

  Modularize agent execution helpers and shared type domains behind compatible facades, preserving public signatures and run-view streaming.
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.19.0
  - @zhivex-ai/anthropic@0.11.1

## 1.0.1

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.18.0
  - @zhivex-ai/anthropic@0.11.0

## 1.0.0

### Major Changes

- Update provider dependencies and Zod to current stable releases. MCP output schemas now enforce uniqueItems, property-count and contains constraints through Zod 4.6.3. Bedrock requires Node.js 20 or newer; Vertex requires Node.js 22 or newer to match their upstream SDKs. Other packages retain their runtime requirements.

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.16.1
  - @zhivex-ai/anthropic@0.10.2

## 0.11.0

### Minor Changes

- 744dec7: Support Claude on Vertex with Google bearer authentication, Anthropic publisher routing, text, client tools, streaming, reasoning, and native structured output on supported models. Reuse Anthropic message mapping through an explicit host transport factory and reject direct-API-only features.

  Keep the Vertex package, factory, and provider identity. Add validated explicit publisher resources to raw prediction, limit raw prediction capabilities to their actual contract, and correct Model Garden coverage documentation. Add separate Vertex Claude catalog entries without inheriting direct Anthropic pricing or recommendations.

### Patch Changes

- Updated dependencies [744dec7]
- Updated dependencies [744dec7]
- Updated dependencies [744dec7]
  - @zhivex-ai/anthropic@0.10.0
  - @zhivex-ai/core@1.12.0

## 0.10.1

### Patch Changes

- Refresh the release-managed model catalog for September 2026, including Astra, Claude 5.1, Gemini 3.8, Muse Spark 1.3, Lyria 3.5, and Qwen. Preserve the frozen core compatibility snapshot and historical retired Kimi entries while removing retired-model recommendations.

  Route OpenAI/Azure Astra through Responses by default and validate its request controls. Add explicit Azure Responses mode for opaque deployment names and normalize Responses reasoning and named tool choice. Validate Gemini 3.8 sampling/prefill/reasoning, recognize Qwen Max/Flash snapshots and Ollama Qwen 3.8, and reject forced tool choices for Claude 5.1. Add typed Claude progress-display and thinking-binding controls with automatic beta headers.

  Catalog additions and offline regression coverage do not imply authenticated model availability or complete parity with every new upstream protocol.

## 0.10.0

### Minor Changes

- 2efba2f: Add first-class support and catalog coverage for Gemini 3.7 Flash, Gemini 3.5 Transcribe and Transcribe Live, Gemini Omni 1.1 Flash, Grok 4.6, and DeepSeek V4 Flash Vision Exp with Files API. Enforce current model-specific reasoning and realtime contracts, and restore the configured Qwen realtime frame-size limit on Bun 1.4.

## 0.9.5

### Patch Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

- Updated dependencies
  - @zhivex-ai/core@1.7.0

## 0.9.4

### Patch Changes

- fc64a26: Promote the shared realtime and live-agent contract to Stable. Harden session
  lifecycle, browser transport and frame encoding, tool-call deduplication,
  post-tool continuation, cancellation, durable idempotency, memory context, and
  fail-closed approvals. Correct provider capability claims and Google/Qwen Live
  protocol handling, and add deterministic installed-package plus live
  Gemini/Qwen/OpenAI certification gates.
- Updated dependencies [fc64a26]
  - @zhivex-ai/core@1.4.0

## 0.9.3

### Patch Changes

- Harden durable subagent recovery, file-store revision CAS, supervised approvals, ledger redaction, artifact integrity, authenticated redirects, provider diagnostics, remote-media policies, Formula tool names, local CLI exports, and release artifact trust boundaries.
- Updated dependencies [888bf99]
- Updated dependencies
  - @zhivex-ai/core@1.1.2

## 0.9.2

### Patch Changes

- 4188b59: Map Gemini GenerateContent usage metadata into the shared token usage contract for generated and streamed responses.
- Updated dependencies [4188b59]
- Updated dependencies [4188b59]
  - @zhivex-ai/core@1.1.0

## 0.9.1

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.
- Updated dependencies [748944f]
  - @zhivex-ai/core@1.0.2

## 0.9.0

### Minor Changes

- Add production-ready support for Gemini 3.6 Flash, Gemini 3.5 Flash-Lite, and the Token Plan-only Qwen 3.8 Max Preview, including model-specific request validation, catalog metadata, documentation, examples, and regression coverage.

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.0.1

## 0.8.3

### Patch Changes

- Updated dependencies [63f9930]
- Updated dependencies [1150a70]
  - @zhivex-ai/core@1.0.0
