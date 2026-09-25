# @zhivex-ai/core

## 1.24.0-next.1

### Patch Changes

- 2fa183b: Reserve only a child's remaining token allowance when resuming approvals, preserving its shared budget identity and lifetime limits. Forward only pending approval decisions across repeated resumes. Release an auxiliary allocation as confirmed zero consumption when its initial checkpoint fails before dispatch, while retaining the operation ID to block unsafe retries.

## 1.24.0-next.0

### Minor Changes

- Add optional per-field context limits and primary-source evidence, separate curated compaction candidates from evaluation artifacts, and expose deterministic opt-in auxiliary model recommendations with freshness, route, credentials, context and cost explanations. Preserve unknown costs and long-context pricing. Add verified GPT-4o mini limits to the SDK-owned catalog.
- Add explicit paid-compaction route binding, durable reservations and attempt receipts. Preserve confirmed auxiliary consumption even when summary validation or persistence fails, block retries with unknown consumption, and recompute model output ceilings after compaction.
  
  Add a Beta CAS-backed shared token budget coordinator with primary-call reservations, child allotments and auxiliary-call admission, retaining unknown allocations and isolating budget ledgers from ordinary run retention.
- Add optional MCP resources, resource templates and prompts contracts, and an opt-in HTTP entry with bounded Streamable HTTP transport, public-client OAuth PKCE discovery, host-owned credentials, typed authentication and indeterminate execution errors. Existing tools-only clients and tool approval defaults remain compatible.

## 1.23.0

### Minor Changes

- e705a21: Add configurable streaming replay retention and queue limits, including opt-in bounded tail replay for long text, object, and agent streams. Preserve full replay and text-only error behavior by default and document collect-based completion checks. Separate raw agent context input from parsed schema output in class and functional APIs. Expose operational error constructors through the agents facade and reject invalid maxSteps before generation.

### Patch Changes

- f35fafe: Persist terminal agent output redaction across successful runs and later guardrail rejection. Sanitize final state, message/step text, tool result payloads, structured output and metadata while preserving durable execution controls. Document the boundary for live streams, intermediate checkpoints and historical records.
- 4f51d78: Preserve failed subagent links and confirmed usage across terminal errors and durable recovery. Aggregate nested descendants once by run ID, expose unknown usage run IDs in budget diagnostics, and prevent replay of failed idempotent delegations. Preserve the primary execution error when saving its failure or notifying subagent completion also fails.

## 1.23.0-next.2

### Patch Changes

- Persist terminal agent output redaction across successful runs and later guardrail rejection. Sanitize final state, message/step text, tool result payloads, structured output and metadata while preserving durable execution controls. Document the boundary for live streams, intermediate checkpoints and historical records.

## 1.23.0-next.1

### Patch Changes

- 15cd12e: Preserve failed subagent links and confirmed usage across terminal errors and durable recovery. Aggregate nested descendants once by run ID, expose unknown usage run IDs in budget diagnostics, and prevent replay of failed idempotent delegations. Preserve the primary execution error when saving its failure or notifying subagent completion also fails.

## 1.23.0-next.0

### Minor Changes

- Add configurable streaming replay retention and queue limits, including opt-in bounded tail replay for long text, object, and agent streams. Preserve full replay and text-only error behavior by default and document collect-based completion checks. Separate raw agent context input from parsed schema output in class and functional APIs. Expose operational error constructors through the agents facade and reject invalid maxSteps before generation.

## 1.22.0

### Minor Changes

- 62539ac: Preserve validated terminal usage on rejected Responses tool calls without emitting unsafe calls.

## 1.21.0

### Minor Changes

- Expose updateContextCache and UpdateContextCacheOptions through the unified SDK. Providers without expiration updates fail with UnsupportedFeatureError.
- Add the optional context-cache expiration update contract and implement Vertex cache PATCH with explicit field masks, expiry validation, retries and deadlines.
- Expose source-backed model lifecycle metadata and expand the SDK Vertex catalog to partner chat and specialized models. Enable supported Claude native tools on Vertex, prompt-cache TTL validation and session affinity, while rejecting unsupported image/document sources and beta features locally.

  Enable Vertex-supported automatic Claude compaction and context editing with body beta flags and strategy validation; keep direct-only on-demand compaction rejected.

  Add a dedicated claude.countTokens client with native Claude message blocks, tools and system inputs, OAuth/location guards, bounded responses and normalized input-token counts.
- Expose realtime tool-call cancellation events with correlated IDs. Vertex maps native cancellation messages; callback sessions suppress cancelled call replays and reject late results locally while retaining the connection. Live agents propagate per-call cancellation to approval waits and tool execution through an optional session signal, retaining indeterminate durable claims when effects may still be running. This does not undo local tool side effects.
- Add a host-neutral Chat Completions transport with tool history, schema output, streaming, reasoning metadata, bounded tool arguments, cancellation and HTTP retries. Expose it as a Beta provider-construction helper.

  Route Vertex publisher/model selectors through Google-authenticated Chat Completions or publisher raw prediction, preserving Vertex provider identity and host-specific reasoning controls. Add explicit chatModel selection for self-deployed endpoints with deployment capability overrides.

  Reject partner selectors on Google-specific factories and include current GLM 5.2, Gemma 4, Llama 4 and gpt-oss 120B MaaS entries in the SDK catalog without inheriting other models' retirement dates or pricing.

  Default GPT OSS and Qwen tool requests to explicit auto choice. Reject GPT OSS required/named choices unsupported by Vertex; this fixes the live host template error when a GPT OSS tool request omits tool_choice.

  Normalize omitted GPT OSS tool descriptions to an empty string, as required by the Vertex Harmony serializer.

  Map required tool choice to the native Mistral publisher value any without changing other publishers.

  Keep self-deployed reasoning capabilities independent of hosted model names. Enforce Chat Completions capability restrictions for native tool-choice, parallel-call and response-format options and streaming. Record Jamba 1.5 retirement metadata in the Vertex catalog.

  Select hosted chat capabilities and thinking controls from exact model profiles instead of publisher/name prefixes. Unknown IDs retain text transport without advertising unverified advanced capabilities.
- Share the authenticated Node/Bun WebSocket transport through core. Vertex Live now connects with OAuth headers without a custom factory; Qwen reuses the same implementation. Keep browser transport selection separate, disable redirects, and handle handshake cancellation/timeout errors without unhandled socket events.
- Forward provider-specific embedding controls through the shared embedding API. Add Vertex embedding model validation and batching, Mistral OCR and Codestral FIM clients, and project-scoped Interactions with resumable streaming, metadata listing and Lyria 3 music generation. Export shared document extraction and text completion input types.

  Route E5 publisher embeddings through the bearer-authenticated OpenMaaS embeddings endpoint, validating vector indices and preserving input order.

  Add prompt-based DeepSeek image extraction to Vertex OCR, reject incomplete extractions and conflicting native options, and validate specialized sampling inputs and OCR page identities.

  Reject duplicate Interactions tool identifiers and indices, validate completed tool arguments, and stop/cancel the response after a terminal streaming event.

  Expose the always-present Vertex embeddingModel factory as required in the returned TypeScript type.

  Preserve all Interactions model-output steps so Lyria lyrics and captions are not discarded when the final step contains audio.

  Decode the documented Interactions arguments_delta events and normalize hosted Maps and Vertex Search tools to google_maps and retrieval. Reject unsupported hosted tool types, including Developer API File Search.

  Route Gemini Omni video models through Interactions with text/image input, inline or GCS output, model-specific resolution validation and catalog entries. Preserve Veo prediction-operation routing.

  Advertise image, document and audio input capabilities on Gemini Embedding 2, while preserving text-only capabilities on legacy and E5 embedding models.

### Patch Changes

- Preserve abnormal server WebSocket close codes and reasons in the authenticated realtime transport instead of reporting every server closure as a normal end of stream.
- Pass the previous session configuration to realtime update callbacks. Vertex Live now updates instructions through system client content instead of resending setup, and rejects immutable configuration changes before sending them.

## 1.20.0

### Minor Changes

- Normalize inline base64 image inputs with their MIME type for Qwen, OpenAI, xAI, Azure OpenAI, Meta, and OpenRouter across Chat/Responses generation and streaming. Preserve HTTP(S) and existing base64 image data URLs without mutating history. Use native base64 source blocks for Anthropic. Share the adapter serializer through Core's provider entrypoint, with explicit validation and a required MIME type for bare base64.

  Observe streamText's internal final-result rejection for consumers that only iterate eventStream or textStream, while preserving the error event and collect() rejection. Add isolated Node regressions for HTTP, network, mid-stream, cancellation, and provider error events.

## 1.19.1

### Patch Changes

- 69afb5a: Avoid polynomial regex backtracking when generating subagent tool names from identifiers containing long runs of underscores, while preserving the existing naming behavior.

## 1.19.0

### Minor Changes

- Add focused Core agent, generation, provider-helper, and catalog entrypoints. Migrate the Agents root, SDK runtime/catalog, and provider helper imports away from the complete Core aggregation while preserving existing public exports. Qwen also uses the focused provider helpers while retaining its multimodal and realtime behavior.

  Separate agent, workflow, and artifact persistence backends and the file generation cache into internal modules without changing schemas, key formats, leases, approvals, or backend behavior. Keep the legacy Core catalog frozen and compatible.

  Modularize agent execution helpers and shared type domains behind compatible facades, preserving public signatures and run-view streaming.
- Add model-aware React media inputs and video rendering, bounded agent execution summaries and hierarchy, and an optional browser realtime voice hook with PCM audio and a server-owned WebSocket relay. Expose optional realtime interruption and implement Qwen response cancellation. Keep provider credentials and tool execution on the server.

  Fix resumed tool approvals so the original tool card completes and the final response remains an assistant message. Include a runnable Qwen Omni/voice example and browser regression coverage for uploads, approvals, replay, microphone capture and interruption.

  Refresh chat spacing, composer focus, responsive prompt cards and agent status badges while preserving theme tokens. Modernize the example's voice controls with explicit microphone state, surfaced action errors and a keyboard alternative. Request PCM output in the voice example and avoid idle provider cancellation when only local playback needs clearing.

## 1.18.0

### Minor Changes

- Add persisted task outcomes that distinguish technical completion from indeterminate effects, and a Beta API for verified external-effect reconciliation with audit history, lease fencing, replay protection, and restart recovery. Serialize file-store journal CAS and lease mutations. Agent evaluations exclude pending reconciliation from passing cases.

## 1.17.0

### Minor Changes

- a909491: Add catalog-backed model cost valuation with cache breakdown, long-context pricing, explicit reasoning semantics, provenance and unknown-cost handling. Gateway costAccounting adds opt-in request quotes and per-attempt reported valuations without changing the legacy rate budget or retrying successful calls on accounting errors.
- 66162f8: Isolate idempotent agent group members by stable identity, reject key collisions, and report pending and cancelled group states instead of premature completion. Existing callers must handle the expanded group status union and reconcile legacy shared group keys before replay.

  Preserve complete reported TokenUsage in gateway text/object generation and streaming collection, estimating only missing base counters.
- 631b733: Add optional FIFO maxConcurrency to agent groups, preserving output order and default parallelism. Cancel queued members before model execution or store claims and drain pending entries after fail-fast cancellation.
- a909491: Add opt-in local circuit breaking and explainable adaptive gateway routing, portable agent history import, and configured agent composition with durable route binding.

  Allow explicitly independent ordinary tools to overlap with subagents configured while keeping serial barriers and journal completion ordering. Reuse validated checkpoint serialization without removing persistence boundaries, and measure the normalized next revision for state limits.

## 1.16.1

### Patch Changes

- Update provider dependencies and Zod to current stable releases. MCP output schemas now enforce uniqueItems, property-count and contains constraints through Zod 4.6.3. Bedrock requires Node.js 20 or newer; Vertex requires Node.js 22 or newer to match their upstream SDKs. Other packages retain their runtime requirements.

## 1.16.0

### Minor Changes

- 0679e5c: Add GPT-Live-1 server WebSocket sessions with continuous audio, timestamped transcripts, client delegation, context appends, input muting and acknowledged close with final usage. Add the provider-neutral runRealtimeDelegations bridge for application-owned agents, with bounded context, serialized backend tasks, duplicate detection and cancellation. Keep full-duplex sessions separate from the turn-based streamLiveAgent lifecycle. Add the model to the SDK catalog without inventing token pricing for duration-billed voice. Responses-managed delegation, browser WebRTC and SIP are not implemented by this adapter.

## 1.15.0

### Minor Changes

- Preserve response usage, finish reason and paired diagnostics when strict tool-name validation rejects a batch. Add ToolNotRegisteredError and explicit unknownToolMode recovery bounded by model steps and agent budgets, without executing or approving unknown calls.

## 1.14.0

### Minor Changes

- ca4cc73: Add opt-in toolExecution.validationErrorMode="tool-result" to return sanitized schema validation errors to the model without executing or approving invalid calls. Preserve strict validation by default, correlate results across mixed batches and approval resumes, and account for current tool errors in agent budget preflight.

## 1.13.0

### Minor Changes

- Expose the shared structured output prompt helper through Core and SDK. Resolve Gateway auto object mode per destination without restarting tool loops, including fallback between native and prompted output.

  Prevent uncooperative stream cleanup from blocking timeout or cancellation. Record terminal stream attempts, reject provider error events consistently, sanitize all attempt diagnostics, and honor bounded Retry-After delays.

- Preserve approval policies, tool choice and lifecycle hooks in object generation. Treat provider stream error events as terminal failures before executing buffered tools.

  Expose withResponseRetry in Core and SDK and use it for OpenAI, Anthropic, Gemini and Qwen language generation/stream startup. Honor Retry-After and share timeout signals with retry waits. Cancel DeepSeek backoff on timeout. Preserve exact Uint8Array and Buffer view boundaries when uploading files through Meta and xAI.

### Patch Changes

- Fix persisted agent compaction counting model usage twice and use current response usage for per-step budget preflight, with or without a run store. Preserve correlated tool-call, approval, and result groups across compaction boundaries, including parallel calls. Serialize synthetic assistant text as output_text in OpenAI Responses while retaining its role and native output metadata.

## 1.12.0

### Minor Changes

- 744dec7: Add an optional model tool-history capability and an opt-in discriminated JSON tool-result format. OpenAI and Qwen Chat/Responses, and DeepSeek Chat, preserve all tool results and can explicitly serialize success/error envelopes for gateway continuation. Existing direct SDK calls retain raw result serialization. Gateway routing honors adapter-declared support, enables cross-provider fallback without replaying resolved tools, and rejects explicit private-thinking replay for the portable DeepSeek/Qwen subset. Their default portable replay runs without thinking.

## 1.11.0

### Minor Changes

- ed84fd9: Add a Beta, schema-versioned provider conformance contract with strict evidence states, TTL expiry, redaction, baseline comparison, fail-closed gates, JSON/Markdown reporting, installed-package evidence, and CI provenance support.

## 1.10.0

### Minor Changes

- 8faf5c9: Add sanitized provider tool-call diagnostics, durable Agent error metadata, and fail-closed OpenAI Responses tool-call assembly that waits for terminal completion before local policy or execution.

## 1.9.1

### Patch Changes

- 0ed1991: Keep delayed worker heartbeats fail-closed after lease expiry, and use bounded release coordination with late cleanup so stalled monitors cannot hang or recreate worker ownership.

## 1.9.0

### Minor Changes

- 4b3a4ec: Add a Beta, instance-local model resolver for explicit `provider/model` identifiers, application aliases, typed preflight failures, and immutable trace/budget metadata while preserving direct provider factories as the canonical path.

## 1.8.0

### Minor Changes

- Add Beta comparative model evaluation suites, built-in scorers, reports, cost and latency summaries, regression thresholds, report comparison, and local CLI commands.

  Add provider-scoped default catalog provenance, focused SDK runtime/workflow/UI/evaluation entrypoints, and an explicit Experimental helper for validated raw provider-option passthrough. Align the stability manifest helpers with their documented Stable contract.

## 1.7.0

### Minor Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

## 1.6.0

### Minor Changes

- Promote Artifact Service, Model Catalog, OpenTelemetry adapters, and the `zhivex-ai` CLI to Stable contracts. Add bounded artifact policies, immutable versioned catalog snapshots, a commit-pinned privacy-first GenAI telemetry contract with model/agent/tool/workflow spans and metrics, official OpenTelemetry SDK lifecycle coverage, strict CLI argument validation, and installed-package CLI/Postgres smoke evidence.

## 1.5.0

### Minor Changes

- Promote SQLite/Postgres workflow state, workflow evaluation baselines and regression gates, and the focused Agent Control Plane contract to Stable. Add fail-closed real-database CI and installed-package certification, versioned workflow evaluation baseline/gate APIs with CLI support, and schema-validated durable single-consumer approval resume through `@zhivex-ai/agents/control-plane`.

## 1.4.0

### Minor Changes

- fc64a26: Promote the shared realtime and live-agent contract to Stable. Harden session
  lifecycle, browser transport and frame encoding, tool-call deduplication,
  post-tool continuation, cancellation, durable idempotency, memory context, and
  fail-closed approvals. Correct provider capability claims and Google/Qwen Live
  protocol handling, and add deterministic installed-package plus live
  Gemini/Qwen/OpenAI certification gates.

## 1.3.0

### Minor Changes

- Add native Z.ai support for GLM-5.3 and GLM-5.2 with model-aware thinking controls, streamed and non-streamed reasoning preservation, function-tool loops, JSON-object structured output, Retry-After-aware backoff, catalog and Gateway registration, CLI scaffolding, and opt-in live smoke coverage.

### Patch Changes

- Add first-class Muse Spark 1.2 support, align tool choice with the authenticated Meta contract, repair retry and Responses streaming behavior in the direct Meta Model API adapter, and add current Muse Glimmer 30B routes for Ollama and OpenRouter with catalog, documentation, and regression coverage.

## 1.2.0

### Minor Changes

- Bring the Ollama adapter up to date with the native REST contract: use object-shaped tool arguments and correlated tool results, surface mid-stream NDJSON errors, preserve thinking through streamed and non-streamed tool loops, expose shared reasoning controls, and add first-class authenticated Ollama Cloud access. Refresh the default Ollama catalog with current Gemma 4, Qwen 3.5, Qwen 3, GPT-OSS, and EmbeddingGemma entries.

## 1.1.2

### Patch Changes

- 888bf99: Fix Postgres-backed agent state, tool-journal, and memory JSON persistence, retry the catalog conflict raised by concurrent table initialization, and publish file-backed execution claims atomically.
- Harden durable subagent recovery, file-store revision CAS, supervised approvals, ledger redaction, artifact integrity, authenticated redirects, provider diagnostics, remote-media policies, Formula tool names, local CLI exports, and release artifact trust boundaries.

## 1.1.1

### Patch Changes

- 0b8ecd5: Add first-class support for the production `qwen3.8-max` contract, including standard Model Studio endpoints, hybrid reasoning, multimodal input, tools, structured output, catalog metadata, documentation, examples, and regression coverage while preserving the separate Token Plan preview behavior.

## 1.1.0

### Minor Changes

- 4188b59: Graduate the declarative workflow runtime, replay and schema contracts, and the in-memory and file-backed workflow state services from Beta to Stable. SQL workflow state services, workflow evaluations, artifact helpers, and CLI workflows remain Beta.

### Patch Changes

- 4188b59: Write file-backed agent, workflow, artifact, and session state through atomic private-file replacements so concurrent readers cannot observe truncated JSON.

## 1.0.3

### Patch Changes

- Fix bodyless HTTP tool responses in Node, honor Qwen realtime frame limits, and refresh GPT-5.6 Terra and Luna pricing.

## 1.0.2

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.

## 1.0.1

### Patch Changes

- Add production-ready support for Gemini 3.6 Flash, Gemini 3.5 Flash-Lite, and the Token Plan-only Qwen 3.8 Max Preview, including model-specific request validation, catalog metadata, documentation, examples, and regression coverage.

## 1.0.0

### Major Changes

- 1150a70: Harden the stable agent and SDK-managed MCP boundaries.

  - Add resumable local-tool approvals with atomic batch preflight, replay-bound decisions, optional signatures, durable approval history, and provider-data isolation.
  - Add typed ephemeral agent context, tool enablement and input/output guardrails, tool error recovery, and schema-validated final agent output.
  - Bind durable runs to canonical harness and execution-environment fingerprints, add app-owned execution authorization, and reject mismatched resumes before side effects.
  - Add durable context compaction with replay and streaming records, plus parent-promoted subagent approvals that resume the same child run.
  - Treat MCP server annotations as untrusted by default, require explicit trust for read-only auto-execution, bound paginated tool discovery, validate declared structured output, and propagate cancellation, timeouts, and idempotency.
  - Propagate AgentCore MCP pagination and cancellation through the Bedrock transport.

  This is a major change because SDK-managed MCP tools that previously auto-executed from an unauthenticated `readOnlyHint` now require approval unless `trustServerToolAnnotations: true` is configured explicitly.

### Minor Changes

- 63f9930: Add the first Zhivex React chat package with headless state, fetch/SSE transport, accessible customizable components, and Runner-aware UI streaming.
