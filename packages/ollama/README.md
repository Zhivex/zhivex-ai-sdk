# @zhivex-ai/ollama

Ollama adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/sdk @zhivex-ai/ollama
```

## Usage

Start Ollama and pull the model before running the example:

```bash
ollama pull qwen3
```

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOllama } from "@zhivex-ai/ollama";

const ollama = createOllama({
  baseURL: process.env.OLLAMA_HOST ?? "http://localhost:11434"
});

const result = await generateText({
  model: ollama("qwen3"),
  prompt: "Explain why local inference is useful.",
  reasoning: {
    effort: "medium"
  }
});

console.log(result.text);
```

The adapter supports streaming, callable and parallel tools, JSON/structured output, image input, thinking, and text embeddings through `ollama.embeddingModel(modelId)`. Exact capabilities depend on the selected local or cloud model.

Tool-call arguments use Ollama's native JSON-object shape in both responses and follow-up assistant history. Legacy responses that encode arguments as JSON strings remain accepted. Streaming `{ "error": ... }` records are surfaced as provider errors even when the HTTP response already started with status 200.

The adapter targets `/api/chat`. Chat-native `logprobs` and `top_logprobs` are supported and validated; `/api/generate`-only `raw` and `template` options are rejected explicitly.

## Thinking and tool loops

The shared reasoning contract maps `effort: "none"` to `think: false`. Recognized Qwen 3/3.5, DeepSeek R1/v3.1, and Gemma 4 models preserve the native `low`, `medium`, `high`, and `max` levels. GPT-OSS accepts only `low`, `medium`, or `high` and cannot disable thinking.

Returned `message.thinking` content is preserved as Ollama `provider-data`, including streamed deltas, and is sent back with assistant tool calls during multi-step loops. `budgetTokens`, reasoning `mode`/`context`, and hiding thinking while an explicit effort is active are rejected instead of being silently ignored.

Use either the shared `reasoning` option or native `providerOptions.think`, not both. Shared reasoning is advertised only for recognized thinking-model families; custom or newly released models can use `providerOptions.think` as the explicit escape hatch.

## Ollama Cloud

The local daemon requires no API key. For direct Ollama Cloud access, use the official Cloud base URL and a key:

```ts
const ollamaCloud = createOllama({
  baseURL: "https://ollama.com/api",
  apiKey: process.env.OLLAMA_API_KEY
});

const result = await generateText({
  model: ollamaCloud("gpt-oss:120b"),
  prompt: "Summarize this design.",
  reasoning: { effort: "high" }
});
```

`baseURL` may be the host root or end in `/api`; the adapter avoids duplicating the path. Direct `ollama.com` requests normally authenticate with `apiKey`, `OLLAMA_API_KEY`, or an explicit `Authorization` header. Custom headers can be provided through `createOllama({ headers })`, and an authenticated custom `fetch` remains supported for gateways that sign requests themselves.

Ollama Cloud does not currently support structured outputs or expose embedding models, so direct Cloud model instances advertise those capabilities as unavailable; model IDs tagged `cloud` or `*-cloud` also disable structured-output metadata. A signed-in local Ollama daemon can still proxy cloud models without passing a Cloud key to this SDK and can embed through locally installed models.

The adapter does not expose provider-hosted tools, Ollama's separate web-search/web-fetch APIs, remote MCP, audio, or files.

`createOllama()` reads `OLLAMA_HOST` and otherwise defaults to `http://localhost:11434`. An explicit `baseURL` takes precedence.

Plain HTTP is accepted only for loopback Ollama endpoints. Remote endpoints require HTTPS unless a server-side integration explicitly sets `allowUnsafeEndpoints: true`.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
