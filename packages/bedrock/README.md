# @zhivex-ai/bedrock

AWS Bedrock adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/bedrock
```

## Runtime modes

The default runtime uses Bedrock Runtime Converse through `@aws-sdk/client-bedrock-runtime`. This keeps existing users on the native AWS path and supports the shared SDK text, streaming, structured output, and callable tool loop.

```ts
import { createBedrock } from "@zhivex-ai/bedrock";

const bedrock = createBedrock({
  region: process.env.AWS_REGION
});

const model = bedrock("anthropic.claude-3-5-sonnet-20240620-v1:0");
```

For Bedrock Mantle/OpenAI-compatible endpoints, opt in with `runtime: "openai"`. This mode sends generation requests to `${baseURL}/responses` and is the path for endpoint-dependent Responses features such as server tools or stateful Responses.

```ts
import { bedrockServerTool, createBedrock } from "@zhivex-ai/bedrock";
import { generateText } from "@zhivex-ai/core";

const bedrock = createBedrock({
  runtime: "openai",
  apiKey: process.env.BEDROCK_API_KEY,
  baseURL: process.env.BEDROCK_OPENAI_BASE_URL
});

await generateText({
  model: bedrock("openai.gpt-oss-120b-1:0"),
  prompt: "Use the available server tool if useful.",
  tools: {
    notes: bedrockServerTool({
      name: "notes",
      type: "server_tool",
      config: { id: "notes" }
    })
  }
});
```

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
