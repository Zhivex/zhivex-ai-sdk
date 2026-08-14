# @zhivex-ai/zai

Native Z.ai GLM adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/zai @zhivex-ai/core zod
```

## GLM-5.2 on the general API

The general pay-as-you-go endpoint is the safe default because it is the endpoint currently documented for `glm-5.2`.

```ts
import { generateText } from "@zhivex-ai/core";
import { createZAI } from "@zhivex-ai/zai";

const zai = createZAI({ apiKey: process.env.ZAI_API_KEY });

const result = await generateText({
  model: zai("glm-5.2"),
  prompt: "Explain why passkeys resist phishing.",
  reasoning: { effort: "high" }
});

console.log(result.text);
```

The default base URL is `https://api.z.ai/api/paas/v4`. `ZAI_BASE_URL` or the `baseURL` option can override it for compatible gateways.

## GLM-5.3 on Coding Plan

As of August 14, 2026, Z.ai documents `glm-5.3` for all Coding Plan tiers. It is not yet listed in the standard Model API OpenAPI catalog or pay-as-you-go pricing. Select the Coding Plan endpoint explicitly:

```ts
const coding = createZAI({
  apiKey: process.env.ZAI_API_KEY,
  endpoint: "coding"
});

const result = await generateText({
  model: coding("glm-5.3"),
  prompt: "Review this authorization boundary.",
  reasoning: { effort: "max" }
});
```

Coding Plan is limited by Z.ai's usage policy to supported coding and agent tools. On that endpoint, requests for `glm-5.2` or `glm-5.1` may be routed upstream to `glm-5.3`; use the general endpoint when exact GLM-5.2 behavior matters.

## Contract

- Text generation and SSE streaming through Chat Completions.
- Local function-tool loops with automatic tool selection. Forced, required, `none`, hosted tools, and provider-advertised parallel calls are not exposed because only `tool_choice: "auto"` is currently documented.
- `reasoning_content` is preserved as Z.ai `provider-data` and replayed unchanged across tool turns. The adapter sends `thinking.clear_thinking: false` when tool state must be preserved.
- GLM-5.3 requires thinking and accepts shared efforts `low`, `high`, and `max`. `none`, `disabled`, and unsupported aliases fail before network I/O.
- GLM-5.2 maps `none`/`minimal` to disabled thinking, `low`/`medium` to `high`, and `xhigh` to `max`.
- Structured output uses Z.ai JSON-object mode plus a schema prompt, followed by local Zod validation. Z.ai does not document strict native JSON Schema enforcement.
- Cached input usage and documented provider finish reasons are normalized into the shared contract.
- The adapter is text-only and does not claim embeddings, vision, audio, realtime, hosted web search, or remote MCP.

Use `providerOptions` for documented Z.ai fields such as `thinking`, `reasoning_effort`, `top_p`, `do_sample`, `stop`, `request_id`, and `user_id`. Do not put private information in provider user identifiers.

## Live smoke

General GLM-5.2 smoke:

```bash
ZAI_API_KEY=... bun run test:integration:zai
```

Coding Plan GLM-5.3 smoke:

```bash
ZAI_API_KEY=... \
ZAI_ENDPOINT=coding \
ZAI_INTEGRATION_MODEL=glm-5.3 \
ZAI_EXTENDED_INTEGRATION=1 \
bun run test:integration:zai
```

A skipped smoke or offline fixture test is not authenticated provider certification.
