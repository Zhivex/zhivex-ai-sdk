# Provider recipes

Provider package READMEs define setup and supported behavior. The [compatibility matrix](#provider-compatibility) is the source of truth for cross-provider SDK behavior. The sections after it are extended usage examples.

## Provider compatibility

The SDK aims to keep the application-facing contract stable, but capability parity is not identical across providers yet. Use this matrix as the source of truth for the currently implemented SDK behavior.

Status shorthand:

- `yes`: implemented in the SDK adapter.
- `model-dependent`: implemented, but gated by the selected model family.
- `endpoint-dependent`: implemented only on a specific provider endpoint or API mode.
- `env/live-tested`: included in the integration registry and skipped unless credentials are present.

<!-- provider-matrix:start -->
| Provider | `streamText` | Tools | `toolChoice` | Structured output | Embeddings | Audio in | Audio out | Realtime sessions | Browser tokens | Reasoning | Web search | Hosted tools / MCP | Agent tier |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | yes | yes | yes | native | yes | yes | yes | yes | yes | model-dependent; GPT-5.6 `max` / `pro` / context | yes | model-dependent Responses hosted tools including image generation, remote MCP, shell/apply patch harness | Tier A |
| xAI | yes | yes | yes | native | no | no | no | no | no | Grok 4.6 `low` / `medium` / `high` / `xhigh`; Grok 4.5 up to `high` | yes | Responses Web Search, X Search, code execution, Collections search, Files API, prompt caching | Tier B |
| Meta | yes | yes | yes | native | no | yes | no | no | no | `effort` | yes | Responses web search, tool search, Files API, prompt caching | Tier B |
| Azure OpenAI | yes | yes | yes | native | yes | yes | yes | yes | yes | `effort` | yes | model-dependent Responses hosted tools, remote MCP, shell/apply patch harness | Tier A |
| Anthropic | yes | yes | yes | native | no | no | no | no | no | Opus 5 `low` / `medium` / `high` / `xhigh` / `max` | yes | native MCP, web search, code execution | Tier B |
| Gemini | yes | yes | yes | native | yes | yes | yes | yes | yes | model-dependent | yes | native | Tier B |
| Vertex | yes | yes | yes | native | yes | yes | yes | yes | no | model-dependent | yes | native | Tier B |
| OpenRouter | yes | yes | yes | native | no | no | no | no | no | `effort` + `budgetTokens` | yes | server tools | Tier C |
| Qwen | yes | yes | yes | JSON object + schema prompt | yes | model-dependent | yes | yes | no | Responses effort / Chat budget | yes | Responses hosted tools; Cloud files, batch, multimodal embeddings, rerank, ASR, TTS, image, video, realtime | Tier B |
| Kimi | yes | yes | yes | native | no | no | no | no | no | K3 `max`; K2.x model-dependent | Formula tool | Formula tools via Chat Completions | Tier C |
| DeepSeek | yes | yes | yes | JSON object | no | no | no | no | no | `none` / `high` / `max` | no | no | Tier B |
| Z.ai | yes | yes | no | JSON object + schema prompt | no | no | no | no | no | 5.3/5.3 Flash `low` / `high` / `max`; 5.2 mapped | no | no | Tier B |
| Bedrock | yes | yes | endpoint-dependent | native | no | no | no | no | no | endpoint-dependent | endpoint-dependent | Converse baseline or Mantle/OpenAI-compatible Responses hosted tools and remote MCP | Tier C / A by runtime |
| Ollama | yes | yes | no | native | yes | no | no | no | no | model-dependent | no | no | Tier C |
<!-- provider-matrix:end -->

Compatibility notes:

- `structured output` means the SDK can use the shared `generateObject()` / `streamObject()` contract. `native` means schema-aware provider support; `prompted` means SDK fallback prompting instead of provider-native schema enforcement.
- Native search preserves [Gemini streaming grounding and attribution](../../packages/gemini/README.md#google-search-sources-in-streaming) and [Qwen Responses output limits and citations](../../packages/qwen/README.md#bounded-responses-search-and-citations). Internal search measurement is separate from citations and token usage; Core/SDK expose `HostedToolUsage` and per-route `capabilities.hostedTools`. Unverified hosted-call limits are not budget guarantees. Model/route live certification remains separate from transport support.
- Qwen Responses validates complete tool-call batches and reports sanitized argument/SSE errors; see [Responses error semantics](../../packages/qwen/README.md#responses-argument-and-stream-errors).
- Qwen structured output uses Chat Completions JSON-object mode plus a schema system prompt, followed by SDK-side schema validation. DashScope does not currently expose strict JSON Schema enforcement for this API.
- `Realtime sessions` means the provider package exposes `realtimeModel().connect()` through the shared `RealtimeSession` contract. `Browser tokens` means the provider also exposes `realtimeModel().createBrowserToken()` for short-lived client-side credentials.
- Gemini, Vertex, Azure OpenAI, and the current OpenAI `gpt-realtime`, `gpt-realtime-2`, `gpt-realtime-2.1`, `gpt-realtime-mini`, and `gpt-realtime-2.1-mini` models support `session.sendMedia()` for image inputs such as `image/jpeg`, which is useful for browser camera-frame loops. Older OpenAI realtime preview models such as `gpt-4o-realtime-preview` and `gpt-4o-mini-realtime-preview` do not currently support image input.
- Gemini and Vertex expose current Google generative media endpoints through `generateImage()`, `generateVideo()`, and `generateMusic()` where the selected model and endpoint support them, including Gemini Image / Nano Banana and Veo 3.1. Gemini and Vertex support Lyria 3 through `generateMusic()`; Vertex routes it through its experimental project-scoped Interactions API using bearer credentials and `global`. Omni video uses the Interactions surface rather than the Veo long-running operation contract. Vertex also exposes Mistral OCR, Codestral FIM and native Virtual Try-On clients; see its package guide for model, region and authentication constraints.
- Gemini exposes Files API, File Search stores, URL Context, Context Caching, Batch API, the GA Interactions API, managed-agent calls, hosted Google tools, and raw prediction helpers. Vertex exposes Gemini Context Caching, Batch API and hosted Google tools, plus Claude text/tools/streaming, supported native tools and prompt caching through `vertex("claude-...")` and Google-authenticated partner chat through publisher-qualified IDs such as `vertex("xai/grok-4.1-fast-reasoning")`. `vertex.chatModel()` targets self-deployed chat endpoints; see the Vertex guide for host-specific capabilities and model retirement constraints. Explicit `predictionModel("publishers/<publisher>/models/<id>")` resources provide raw prediction transport; they do not imply complete Model Garden compatibility. Vertex also accepts self-deployed `endpoints/<id>` prediction resources. `vertex.endpoints.rawPredict()` preserves arbitrary text/binary HTTP payloads and bounded response bytes for deployed containers. Its native Batch API uses Cloud Storage/BigQuery input and output with Google Cloud bearer authentication.
- `model-dependent` means the provider package exposes the shared capability, but the exact accepted config depends on the selected model family. OpenAI exposes GPT-5.6 Sol, Terra, Luna, and the `gpt-5.6` alias through Responses by default, with Programmatic Tool Calling, Multi-agent, explicit prompt cache breakpoints, and model-gated agent tools. Tool Search and Computer Use are also accepted on GPT-5.5 base and GPT-5.4 base/mini; shell, apply patch, and skills have their own documented gates. Unsupported combinations are rejected before a request is sent. Azure OpenAI retains its deployment- and API-version-dependent capability mapping. Current Anthropic families expose native structured output through `output_config.format`; model-specific effort, thinking, sampling, and prefill constraints are validated before network requests. Claude Opus 5 exposes the complete `low` / `medium` / `high` / `xhigh` / `max` effort ladder and adaptive thinking by default. `budgetTokens` remains available only on models that still accept manual thinking such as Claude Haiku 4.5. Gemini and Vertex reasoning currently map `effort` for Gemini 3 models and `budgetTokens` for Gemini 2.5 and earlier models. QwenCloud also has explicit DeepSeek V4/V4.1, GLM 5.2/5.3, Kimi K3, and MiniMax M2.5 profiles; see the [hosted third-party model matrix](../../packages/qwen/README.md#third-party-models-hosted-by-qwencloud) for capabilities, protocol differences, and live validation. Qwen maps reasoning differently by protocol: Responses sends `reasoning.effort`, while Chat Completions sends `enable_thinking` and optional `thinking_budget`. Kimi K3 maps shared `reasoning.effort: "max"` to top-level `reasoning_effort: "max"`, while K2.6, K2.5, and legacy thinking models use `thinking.enabled/disabled`; `kimi-k2.7-code` and `kimi-k2.7-code-highspeed` keep preserved thinking enabled. DeepSeek reasoning maps `effort` to `thinking` plus `reasoning_effort` for `deepseek-v4-flash` and `deepseek-v4-pro`. Z.ai GLM-5.3 and GLM-5.3 Flash require thinking with `low`, `high`, or `max`; GLM-5.2 maps the broader shared effort ladder to its documented enabled/disabled and `high`/`max` controls.
- xAI uses Responses by default. Grok 4.6 supports `low`, `medium`, `high`, and `xhigh`; Grok 4.5 supports up to `high`. Reasoning is always active on both families and defaults to `high`. Use `providerOptions.conversationId` to route Responses requests through `prompt_cache_key`; Chat compatibility mode sends the same value through `x-grok-conv-id`.
- Meta uses `muse-spark-1.3` as the current documented application default, catalogs the official `muse-spark-1.3-contributor` variant, uses `muse-spark-1.2-contributor` by default only in authenticated integration smoke, and retains Muse Spark 1.1 for existing applications. Contributor catalog entries omit pricing. The direct Meta Model API adapter exposes Chat and Responses generation, callable tools, native structured output, vision, MP3/WAV audio input, reasoning effort, Responses web search/tool search, Files API, and prompt caching. Meta Model API also offers a native Responses `computer` tool; the SDK Meta adapter does not yet map its call/output protocol, so its native `computerUse` capability flag remains disabled. The portable `runComputerUse()` path works with Meta through callable tools and screenshots.
- Meta accepts only `toolChoice: "auto"`, which is also the default; `"none"`, `"required"`, and named-tool choices are rejected locally because the live API rejects them.
- Muse Glimmer 30B is available through the existing OpenRouter adapter as `meta/muse-glimmer-30b` and through Ollama as `muse-glimmer:30b` or `muse-glimmer:30b-mlx`. These routes are first-class catalog entries. They do not turn the direct Meta Model API package into a Glimmer host, and exact local vision/tool support still depends on the installed Ollama build and model artifact.
- Bedrock native Converse supports common `toolChoice` values by mapping specific tools and required tools to AWS-native `toolConfig`, and by omitting tool configuration for `toolChoice: "none"`. Bedrock native Converse uses the AWS SDK credential chain by default; it also supports Amazon Bedrock API keys through `AWS_BEARER_TOKEN_BEDROCK` or `createBedrock({ region, apiKey })` for development and exploration. Bedrock OpenAI-compatible mode uses a Mantle/OpenAI-compatible base URL and sends Requests to `/responses`; pass AWS's `OPENAI_API_KEY` / `OPENAI_BASE_URL` values explicitly as `apiKey` / `baseURL` if you use that naming. In the SDK's agent matrix, Bedrock Tier A applies to `createBedrock({ runtime: "openai" })`, which exposes Responses hosted tools, remote MCP, and approval requests. AWS-native AgentCore MCP is exposed separately as SDK-managed MCP tools for Converse or any shared agent loop; it does not promote Converse itself to a provider-emitted approval runtime.
- Kimi K3 always reasons and accepts `toolChoice: "auto"`, `"none"`, or `"required"`; selecting a specific function is incompatible with thinking. K2.6 and K2.7 Code do not accept `"required"`, and specific tools remain unavailable while thinking is enabled.
- Ollama uses the native `/api/chat` contract. Recognized Qwen 3/3.5, DeepSeek R1/v3.1, and Gemma 4 models preserve native `low`, `medium`, `high`, and `max` reasoning levels. Muse Glimmer preserves `none`, `low`, `medium`, and `high`; `max` is rejected because Ollama does not document that strength for Glimmer. GPT-OSS accepts only `low`, `medium`, and `high` and cannot disable thinking. Returned thinking is preserved through streamed and non-streamed tool loops. Direct `ollama.com` access accepts `apiKey`/`OLLAMA_API_KEY`, while authenticated custom fetchers remain supported. Direct Cloud disables embedding and structured-output capability metadata; `cloud`/`*-cloud` model IDs reached through a local daemon also disable structured output. Exact tools, vision, thinking, and embedding support still depend on the installed or selected model.

- Portable computer use runs an application-owned browser or desktop with any model route that supports images and callable tools. See the [Computer Use guide](../COMPUTER_USE.md) for a Qwen 3.8 Flash example, action authorization, and limits.
- DeepSeek is Tier B for portable tool loops plus documented thinking mode on `deepseek-v4-flash` and `deepseek-v4-pro`. Both models have a 1M-token context window, up to 384K output tokens, JSON output, function tools, and automatic upstream context caching. The experimental `deepseek-v4-flash-vision-exp` model matches Flash's text capabilities and pricing, and adds ordered JPEG, PNG, GIF, and WebP input through inline data, external URLs, or DeepSeek Files API IDs; the provider exposes typed upload/list/get/delete helpers for that path. Image inputs add up to 384 billed tokens each. The adapter reports cached-input and reasoning-token usage and preserves streaming chat/FIM logprobs when DeepSeek returns those details. DeepSeek documents account-level concurrency limits of 2,500 for Flash and 500 for Pro; `user_id` must not contain private information. This adapter still does not expose hosted tools, remote MCP, provider-hosted web search, embeddings, audio, or realtime sessions; DeepSeek separately exposes web search through its Anthropic-compatible endpoint for supported agent integrations.
- Use the V4 model IDs directly. DeepSeek retired the compatibility aliases `deepseek-chat` and `deepseek-reasoner` on July 24, 2026 at 15:59 UTC, so they are intentionally not catalog aliases.
- Strict function schemas are an opt-in DeepSeek Beta feature. Set `providerOptions.strictTools: true`; the adapter routes that request through DeepSeek's Beta endpoint automatically, marks every callable function as strict, and validates DeepSeek's restricted JSON Schema subset locally before network I/O.
- Native DeepSeek `generateObject()` / `streamObject()` requests automatically receive the provider-required JSON instruction plus the requested schema; DeepSeek guarantees a JSON object and the SDK performs the Zod schema validation locally.
- `providerOptions.prefix` exposes Beta chat prefix completion and also routes automatically. The provider additionally exposes `deepseek.fim.generate()` / `deepseek.fim.stream()` for Beta FIM completion on `deepseek-v4-flash` and `deepseek-v4-pro`, typed `deepseek.models.list()` / `deepseek.balance.get()` clients, and `deepseek.files` for the Vision Files API. FIM is non-thinking. Although the official FIM guide/reference still describe older Pro/4K constraints, the pricing table and live API support both V4 models and values above 4,096; the adapter therefore accepts a positive integer and lets the API enforce its current model ceiling.
- DeepSeek V4 thinking mode supports tool loops but does not accept an explicit `tool_choice` field. Leave `toolChoice` unset while thinking is enabled; disable thinking with `reasoning: { effort: "none" }` before using `none`, `required`, or a specific-tool choice.
- Qwen Token Plan supports explicit plan routing for `qwen3.8-max` and `qwen3.8-flash` with a dedicated key and `QWEN_TOKEN_PLAN_BASE_URL`. The current QwenCloud endpoint and the previous Singapore endpoint are accepted; use the final Max ID instead of the retired preview. See [Token Plan setup](../../packages/qwen/README.md#qwencloud-token-plan-personal-and-team). Plan access is separate from pay-as-you-go and is not live-certified by mocked contract tests.
- Z.ai is Tier B for portable text/tool loops. The adapter preserves `reasoning_content` across streamed and non-streamed tool turns, supports JSON-object structured output with schema prompting and local validation, and exposes only automatic tool selection. `glm-5.3-flash` adds native ordered image input and is available through both the general Model API and GLM Coding Plan; `glm-5.3` and Flash require thinking. `createZAI()` defaults to the general endpoint, while `createZAI({ endpoint: "coding" })` remains explicit for Coding Plan credentials. Offline contract tests do not certify authenticated availability.
- Kimi Formula tools are exposed as public helpers in `@zhivex-ai/kimi`. The SDK loads or declares Formula tool schemas, maps them into Chat Completions function tools, tracks `function.name -> formula_uri`, and executes the official Formula fiber after a Kimi tool call. Moonshot currently marks Formula web search as being updated and not recommended for near-term production use.
- `Hosted tools / MCP` refers to provider-native hosted tools or SDK-level MCP mappings, not local callable tools defined with `tool()`. Kimi Formula helpers are called out separately because they are official provider tools executed through Formula fibers. For OpenRouter this currently means server tools such as `openrouter:web_search`.
- `Agent tier` summarizes how far the provider currently goes for the agent runtime:
- `Tier A`: native agent building blocks including approval-capable remote MCP or equivalent hosted tools.
- `Tier B`: strong tool-using agent support, but with more provider-specific gaps or fewer hosted-agent features.
- `Tier C`: basic (Tier C). Usable for basic tool loops, but not yet something the SDK should market as full agent support.
- The direct providers support `gpt-6-sol`, `gpt-6-luna`, `claude-opus-5-5`, and `claude-sonnet-5-5`. GPT-6 Sol and Luna default to Responses; Chat Completions function calling requires reasoning effort `none`. Opus 5.5 uses always-on adaptive thinking and accepts only automatic or disabled tool choice. See the [OpenAI adapter](../../packages/openai/README.md) and [Anthropic adapter](../../packages/anthropic/README.md). Sonnet 5.5 maps reasoning effort `none` to `between_tools` and rejects forced tools, disabled or manual thinking, and incompatible effort settings before sending requests. The SDK catalog includes their direct-provider token and cache prices; Sonnet 5.5 on Vertex has a separate entry without inferred pricing.
- Qwen 3.8 LiveTranslate is available through `realtimeModel("qwen3.8-livetranslate-flash-realtime")`. See [configuration, voice cloning limitations, and live verification](../../packages/qwen/README.md#qwen-38-livetranslate).


## Switching Providers

The application-facing API remains the same. In most cases, switching providers only requires replacing the adapter factory and model identifier.

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const prompt = "Respond in one short sentence.";

const fromOpenAI = await generateText({
  model: openai("gpt-4o-mini"),
  prompt
});

const fromAnthropic = await generateText({
  model: anthropic("claude-sonnet-5"),
  prompt
});

console.log(fromOpenAI.text);
console.log(fromAnthropic.text);
```


## OpenAI GPT-6 Astra

The OpenAI CLI starter and canonical Quickstart use `gpt-6-astra`. The adapter selects the Responses API automatically, including for tool calling and structured output. Existing explicit model selections and lower-cost alternatives remain available.

When migrating a request, use reasoning effort `low` in place of `none` or `minimal`; preserve `medium`, `high`, `xhigh`, or `max`. Remove `temperature`, `top_p`, and logprob controls, and replace `prompt_cache_retention` with `prompt_cache_options: { ttl: "30m" }` if caching was configured. Astra tool calling requires Responses; do not force `apiMode: "chat"` for agents. The adapter rejects incompatible sampling and reasoning settings locally.

Access depends on your OpenAI organization's rollout eligibility. See the [official Astra migration guide](https://developers.openai.com/api/docs/guides/latest-model) and [model page](https://developers.openai.com/api/docs/models/gpt-6-astra).

```ts
const result = await generateText({
  model: createOpenAI({ apiKey: process.env.OPENAI_API_KEY })("gpt-6-astra"),
  prompt: "Review this architecture and identify its highest-risk assumption.",
  reasoning: { effort: "high" }
});
```

## OpenAI GPT-5.6

The OpenAI adapter recognizes `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. The `gpt-5.6` alias selects Sol. All GPT-5.6 variants use the Responses API by default in this adapter; pass `providerOptions.apiMode: "chat"` only when you explicitly need Chat Completions and are not using Responses-only tools or Multi-agent.

GPT-5.6 is currently an upstream limited preview for approved organizations, with API and Codex access granted separately and no public enrollment. For prompts above 272K input tokens, the entire request is billed at 2x the input rate and 1.5x the output rate. See [OpenAI's preview access notes](https://help.openai.com/en/articles/20001325-a-preview-of-gpt-5-6-sol-terra-and-luna) and the [GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol).

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const result = await generateText({
  model: openai("gpt-5.6"),
  prompt: "Review this architecture and identify its highest-risk assumption.",
  reasoning: {
    effort: "max",
    mode: "pro",
    context: "all_turns"
  },
  providerOptions: {
    apiMode: "responses",
    safety_identifier: "user_8f2a"
  }
});

console.log(result.text);
```

`reasoning.mode` and `reasoning.context` are Responses-only. The adapter rejects them in Chat Completions instead of silently omitting them. `reasoning.effort`, including `"max"`, works through the endpoint-specific mapping.

For stateless or Zero Data Retention flows, set `providerOptions.store: false`. The adapter adds `reasoning.encrypted_content` to the include list and replays the returned reasoning/output items instead of relying on `previous_response_id`.

`providerOptions.safety_identifier` should be a stable, non-PII identifier for the end user.

### OpenAI image generation

The OpenAI adapter exposes `gpt-image-2` through the shared buffered image API:

```ts
import { generateImage } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const image = await generateImage({
  model: openai.imageGenerationModel!("gpt-image-2"),
  prompt: "A wide architectural concept sketch for a resilient data platform",
  aspectRatio: "16:9",
  outputMimeType: "image/webp",
  providerOptions: { quality: "high" }
});

console.log(image.images[0]?.mediaType);
```

For conversational edits, reference images, or progressive previews, use `openAIImageGenerationTool()` with a Responses model. `streamText()` emits partial and final `image-generation` events. Partial previews are delivered only to live `eventStream` consumers and are not retained for later replay by `collect()` or `textStream`; final images remain available at `result.steps.at(-1)?.response.images` after collection. `openAIImageGenerationToolChoice()` forces the hosted tool when required.

Hosted image SSE decoding is bounded by default to 32 MiB per partial/final event and 128 MiB accumulated per stream. Adjust those budgets at provider creation when the application has stricter or larger trusted workloads:

```ts
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  responseLimits: {
    hostedImageEventBytes: 16 * 1024 * 1024,
    hostedImageTotalBytes: 64 * 1024 * 1024
  }
});
```

OpenAI prompt caching can use request-level controls and explicit content breakpoints. Set a breakpoint either with `providerMetadata.openai.prompt_cache_breakpoint` on a text, image, or file part, or place `openAIPromptCacheBreakpoint()` immediately after the content block to cache:

```ts
import { user } from "@zhivex-ai/sdk";
import { openAIPromptCacheBreakpoint } from "@zhivex-ai/openai";

const cached = await generateText({
  model: openai("gpt-5.6-terra"),
  messages: [
    user([
      { type: "text", text: "Reusable project documentation" },
      openAIPromptCacheBreakpoint(),
      { type: "text", text: "Summarize the deployment constraints." }
    ])
  ],
  providerOptions: {
    prompt_cache_key: "project-docs-v1",
    prompt_cache_options: { mode: "explicit", ttl: "30m" }
  }
});
```

`prompt_cache_retention` remains available as a legacy alternative for older model families; do not combine it with `prompt_cache_options` for GPT-5.6. The normalized usage object exposes `cachedInputTokens` and `cacheWriteTokens` for cache cost tracking.

The GPT-5.6 Responses integration also includes Programmatic Tool Calling and the Multi-agent beta. Programmatic callable tools declare their permitted caller and optional output schema through `openAIProgrammaticTool()`. Multi-agent mode adds the required beta header automatically and keeps the root agent's final answer:

```ts
import { tool } from "@zhivex-ai/sdk";
import {
  openAIProgrammaticTool,
  openAIProgrammaticToolCallingTool
} from "@zhivex-ai/openai";
import { z } from "zod";

const lookup = openAIProgrammaticTool(
  tool({
    name: "lookup",
    schema: z.object({ id: z.string() }),
    execute: ({ id }) => ({ id, status: "ready" })
  }),
  {
    allowedCallers: ["programmatic"],
    outputSchema: z.object({ id: z.string(), status: z.string() })
  }
);

await generateText({
  model: openai("gpt-5.6-luna"),
  prompt: "Check the records and delegate independent verification.",
  maxSteps: 4,
  tools: {
    program: openAIProgrammaticToolCallingTool(),
    lookup
  },
  providerOptions: {
    multi_agent: { enabled: true, max_concurrent_subagents: 2 }
  }
});
```

See [`@zhivex-ai/openai`](../../packages/openai/README.md) for model capability gates and GPT-5.6-specific provider options.

For GPT-5.6 Computer Use GA, use `openAIComputerTool()` and provide the app-owned action executor that returns a `computer_screenshot`. The legacy `openAIComputerUseTool()` preview helper remains available for older integrations. `openAIShellTool()` supports local skills in an app-owned execution root; `openAIHostedShellTool()` is the separate provider-executed path for `container_auto` or `container_reference` and never re-runs commands locally. Hosted networking is off by default. If enabled, restrict `network_policy.allowed_domains`, scope `domain_secrets` to their exact domain, and treat every allowlisted host as a possible prompt-injection exfiltration channel. See OpenAI's [Hosted Shell safety guidance](https://developers.openai.com/api/docs/guides/tools-shell#network-access).
