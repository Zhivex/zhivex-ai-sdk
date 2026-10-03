# @zhivex-ai/meta

Meta Model API adapter for Zhivex AI SDK. `muse-spark-1.3` is the recommended direct Meta model; the official `muse-spark-1.3-contributor` and `muse-spark-1.2-contributor` variants and older IDs such as `muse-spark-1.1` remain usable when they are available to your Meta project.

## Install

```bash
bun add @zhivex-ai/core @zhivex-ai/meta
```

## Usage

```ts
import { generateText } from "@zhivex-ai/core";
import { createMeta } from "@zhivex-ai/meta";

const meta = createMeta({
  apiKey: process.env.MODEL_API_KEY
});

const result = await generateText({
  model: meta("muse-spark-1.3"),
  prompt: "Explain tool calling in one sentence."
});

console.log(result.text);
```

The adapter defaults to `https://api.meta.ai/v1` and reads `MODEL_API_KEY` when no key is passed explicitly.

## API modes and provider features

Chat Completions is used for ordinary text, vision, callable tools, and structured output. Set `providerOptions.apiMode` to `"responses"`, or use files or Meta hosted tools, to use the Responses API:

```ts
import { generateText } from "@zhivex-ai/core";
import { createMeta, metaToolSearchTool, metaWebSearchTool } from "@zhivex-ai/meta";

const meta = createMeta({ apiKey: process.env.MODEL_API_KEY });

const result = await generateText({
  model: meta("muse-spark-1.3"),
  prompt: "Find the current primary source and summarize it.",
  tools: {
    webSearch: metaWebSearchTool(),
    toolSearch: metaToolSearchTool({
      execution: "client",
      description: "Find a tool by name.",
      parameters: { type: "object", properties: { query: { type: "string" } } }
    })
  },
  providerOptions: {
    prompt_cache_key: "research-prefix-v1",
    prompt_cache_retention: "24h"
  }
});
```

Responses streaming supports text deltas, fragmented function-call arguments, and continuation through `previous_response_id`. Retryable HTTP statuses (`408`, `429`, and `5xx`) are retried when `maxRetries` is configured, before a JSON body or SSE stream is consumed.

Meta Model API accepts only `toolChoice: "auto"` (which is also the default). The adapter rejects `"none"`, `"required"`, and named-tool choices before sending a request.

The shared Zhivex `audio` part is supported for MP3 and WAV input. Chat Completions sends inline base64 audio; Responses additionally accepts base64 data URLs and uploaded Meta file IDs. Audio output is not supported.

Meta Model API has a native `computer` tool on Responses. The current Zhivex Meta adapter does not yet map native `computer_call` and `computer_call_output` items, so its native `computerUse` capability remains `false`. Use `runComputerUse()` for the SDK's portable function-and-screenshot path. The [native probe](../../examples/meta-native-computer-probe.ts) demonstrates the direct Meta protocol against an isolated page.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
- <https://developer.meta.com/ai/models/muse-spark/>
- <https://dev.meta.ai/docs/protocols/responses>
- <https://dev.meta.ai/docs/video-understanding>
- <https://dev.meta.ai/docs/computer-use>

## Muse Spark 1.3

The SDK catalog includes `muse-spark-1.3` and `muse-spark-1.3-contributor`. Pass either exact ID to `languageModel()` to use the existing Chat or Responses adapter, including structured output, tools, streaming, and reasoning. Meta's announcement confirms `max` reasoning availability for Standard 1.3. Pricing is omitted from the catalog; no 1.2 price is inherited. Existing 1.2 integrations and smoke defaults remain available.

See [Meta's release announcement](https://research.meta.ai/blog/introducing-muse-spark-1-3).

File uploads preserve the exact bytes of a supplied `Uint8Array` or `Buffer` view, including slices with nonzero offsets.
