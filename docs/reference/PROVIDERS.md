# Provider recipes

Provider package READMEs define setup and supported behavior. These are extended usage examples.

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

## September 2026 Model Refresh

The release-managed catalog now includes GPT-6 Astra (OpenAI and Azure), Claude Fable/Mythos 5.1, Gemini 3.8 Flash (Gemini and Vertex), Muse Spark 1.3, Lyria 3.5, and new Qwen entries. Astra uses Responses by default, Gemini 3.8 validates provider-managed sampling and reasoning, Claude 5.1 rejects forced tools, and Qwen Max snapshots retain their exact IDs. Retired Kimi models remain available for historical lookup but are excluded from recommendations.

See [model refresh scope and evidence](../history/MODEL_REFRESH_2026_09.md) for account restrictions, catalog-only additions, and upstream features outside this update.

