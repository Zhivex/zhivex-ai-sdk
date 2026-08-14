# @zhivex-ai/meta

Meta Model API adapter for Zhivex AI SDK. `muse-spark-1.2` is the recommended direct Meta model; the official `muse-spark-1.2-contributor` variant and older IDs such as `muse-spark-1.1` remain usable when they are available to your Meta project.

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
  model: meta("muse-spark-1.2"),
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
  model: meta("muse-spark-1.2"),
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

Meta computer use is composed from callable functions and screenshots rather than a native hosted computer tool; accordingly, the native `computerUse` capability remains `false`.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
- <https://developer.meta.com/ai/models/muse-spark/>
- <https://dev.meta.ai/docs/protocols/responses>
- <https://dev.meta.ai/docs/video-understanding>
- <https://dev.meta.ai/docs/computer-use>
