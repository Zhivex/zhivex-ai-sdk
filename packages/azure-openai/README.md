# @zhivex-ai/azure-openai

Azure OpenAI adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/core @zhivex-ai/azure-openai
```

## Audio response limits

Azure transcription and speech responses are bounded before JSON parsing or binary buffering. Configure application-specific limits through `createAzureOpenAI({ responseLimits })`; defaults are 16 MiB for speech, 4 MiB for transcription JSON, and 64 KiB for error bodies.

Authenticated Azure OpenAI requests reject redirects so a `307` or `308` cannot replay the `api-key` header or request body to another origin. The adapter's explicit `rawFetch` escape hatch remains uncredentialed.

```ts
const azure = createAzureOpenAI({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  responseLimits: {
    speechBytes: 16 * 1024 * 1024,
    transcriptionBytes: 1024 * 1024
  }
});
```

## Capability notes

The adapter exposes model-specific agent capabilities at runtime and validates hosted Responses tools before sending requests. Tools such as `tool_search`, `computer_use_preview`, shell, apply patch, and skills are therefore accepted only for model families the SDK marks as supported.

```ts
import { createAzureOpenAI, azureOpenAIToolSearchTool } from "@zhivex-ai/azure-openai";
import { generateText, getAgentCapabilities } from "@zhivex-ai/core";

const azure = createAzureOpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  endpoint: process.env.AZURE_OPENAI_ENDPOINT
});

console.log(getAgentCapabilities(azure("gpt-5.4")).toolSearch);
console.log(getAgentCapabilities(azure("gpt-5.4-nano")).toolSearch);

await generateText({
  model: azure("gpt-5.4"),
  prompt: "Inspect the available project tools.",
  tools: {
    search: azureOpenAIToolSearchTool()
  }
});
```

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>

## Authentication, deployments, and retries

Pass `apiKey` or a `tokenProvider` function, not both. `tokenProvider` is called on every request and sends `Authorization: Bearer`. It ignores `AZURE_OPENAI_API_KEY`. `azureEntraTokenProvider(credential)` adapts a structural `getToken()` credential, so `@azure/identity` stays optional and is not a dependency. Use scope `https://cognitiveservices.azure.com/.default` for classic Azure OpenAI or `https://ai.azure.com/.default` for Foundry. A 401 becomes `AzureOpenAIAuthenticationError` and is not retried. The caller needs the Cognitive Services OpenAI User role.

Map opaque deployment names with `deployments: { "my-gpt": { model: "gpt-5" } }` or `providerOptions.baseModel`. The deployments map selects capabilities at construction. `baseModel` on a single call overrides that model for token limits, Responses versus Chat, and reasoning validation. Reasoning chat models (`gpt-5`, `gpt-6`, `o1`, `o3`, `o4`, `codex-mini`) send `max_completion_tokens` even when `reasoning` is omitted.

Responses requests always go to `{endpoint}/openai/v1/responses` and include `model`, including when `apiVersion` selects the dated deployment path for Chat Completions. Calls that omit `maxRetries` retry twice. `retry-after-ms` and `x-ms-retry-after-ms` are honored with a small jitter. An HTTP 400 whose error code is `content_filter` is `AzureOpenAIContentFilterError` and is not retried. Usage reports cached input tokens and reasoning tokens when Azure sends them.

## GPT-6 Astra and Responses deployments

`azure("gpt-6-astra")` selects Responses by default for generation, structured output, callable tools, and streaming. For an opaque deployment name, select `providerOptions: { apiMode: "responses", baseModel: "gpt-6-astra" }` when the deployment name is not the model id. Reasoning validation uses that per-call `baseModel`. Responses uses native `reasoning.effort` and flat named-function tool choices. Astra rejects unsupported reasoning efforts, temperature, and `top_p` before fetch. Azure deployment availability, API versions, and quotas remain account-specific.

See [Microsoft's model contracts](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure). Azure pricing is not copied from OpenAI's direct API.

### Chat Completions streaming guarantees

Chat Completions streams assemble parallel tool calls by their stream index and
emit validated calls after the terminal finish reason. The final `finish` event
includes usage even when Azure sends it in a separate trailing chunk. Streams
that end without a finish reason fail explicitly; length-limited or filtered
responses do not emit partial tool calls. Stopping stream iteration releases the
response body.
