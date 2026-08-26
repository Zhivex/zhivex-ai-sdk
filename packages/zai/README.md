# @zhivex-ai/zai

Native Z.ai GLM adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/zai @zhivex-ai/core zod
```

## GLM-5.3 Flash

`glm-5.3-flash` is available through the general Model API and GLM Coding Plan. It has a 1M-token context window, native image understanding, required thinking, streamed tool calls, and the same text parameter contract as GLM-5.3. The general pay-as-you-go endpoint remains the provider default:

```ts
import { generateText } from "@zhivex-ai/core";
import { createZAI } from "@zhivex-ai/zai";

const zai = createZAI({ apiKey: process.env.ZAI_API_KEY });

const result = await generateText({
  model: zai("glm-5.3-flash"),
  messages: [
    {
      role: "user",
      parts: [
        { type: "text", text: "Review this architecture diagram." },
        {
          type: "image",
          image: "https://example.com/architecture.png",
          mediaType: "image/png"
        }
      ]
    }
  ],
  reasoning: { effort: "max" }
});

console.log(result.text);
```

The default base URL is `https://api.z.ai/api/paas/v4`. `ZAI_BASE_URL` or the `baseURL` option can override it for compatible gateways. Image parts preserve their message order and accept public HTTP(S) URLs, image Data URLs, or raw base64 normalized to a Data URL. Multiple images are supported; audio, video, and generic file parts remain outside this model contract.

## General API and Coding Plan

Use the default general endpoint for pay-as-you-go `glm-5.3-flash`, `glm-5.3`, or `glm-5.2` calls. Select the Coding Plan endpoint explicitly when using a Coding Plan credential:

```ts
const coding = createZAI({
  apiKey: process.env.ZAI_API_KEY,
  endpoint: "coding"
});

const result = await generateText({
  model: coding("glm-5.3-flash"),
  prompt: "Review this authorization boundary.",
  reasoning: { effort: "max" }
});
```

Coding Plan is limited by Z.ai's usage policy to supported coding and agent tools. Use the general endpoint when exact pay-as-you-go routing or model behavior matters.

## Contract

- Text generation and SSE streaming through Chat Completions.
- Local function-tool loops with automatic tool selection. Forced, required, `none`, hosted tools, and provider-advertised parallel calls are not exposed because only `tool_choice: "auto"` is currently documented.
- `reasoning_content` is preserved as Z.ai `provider-data` and replayed unchanged across tool turns. The adapter sends `thinking.clear_thinking: false` when tool state must be preserved.
- GLM-5.3 and GLM-5.3 Flash require thinking and accept shared efforts `low`, `high`, and `max`. `none`, `disabled`, and unsupported aliases fail before network I/O. Flash defaults `thinking.clear_thinking` to `false`, matching the model-specific recommendation.
- GLM-5.2 maps `none`/`minimal` to disabled thinking, `low`/`medium` to `high`, and `xhigh` to `max`.
- GLM-5.3 Flash exposes image understanding through ordered `image_url` content blocks. Other Z.ai models remain text-only until their individual media contracts are modeled.
- Structured output uses Z.ai JSON-object mode plus a schema prompt, followed by local Zod validation. Z.ai does not document strict native JSON Schema enforcement.
- Cached input usage and documented provider finish reasons are normalized into the shared contract.
- The adapter does not claim embeddings, audio, realtime, hosted web search, or remote MCP. Vision is exposed only for GLM-5.3 Flash.

Use `providerOptions` for documented Z.ai fields such as `thinking`, `reasoning_effort`, `top_p`, `do_sample`, `stop`, `request_id`, and `user_id`. Do not put private information in provider user identifiers.

## Live smoke

General GLM-5.3 Flash smoke:

```bash
ZAI_API_KEY=... \
ZAI_INTEGRATION_MODEL=glm-5.3-flash \
ZAI_EXTENDED_INTEGRATION=1 \
bun run test:integration:zai
```

Add `ZAI_INTEGRATION_IMAGE_URL=https://...` and optionally `ZAI_INTEGRATION_IMAGE_MEDIA_TYPE=image/png` to include the authenticated vision smoke.

Coding Plan GLM-5.3 Flash smoke:

```bash
ZAI_API_KEY=... \
ZAI_ENDPOINT=coding \
ZAI_INTEGRATION_MODEL=glm-5.3-flash \
ZAI_EXTENDED_INTEGRATION=1 \
bun run test:integration:zai
```

A skipped smoke or offline fixture test is not authenticated provider certification.
