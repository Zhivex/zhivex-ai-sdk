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

For production, prefer the standard AWS SDK credential chain: IAM roles, IAM Identity Center / SSO, profiles, or temporary credentials. For exploration and development, Amazon Bedrock API keys are also supported by setting the official `AWS_BEARER_TOKEN_BEDROCK` environment variable before creating the client:

```bash
export AWS_REGION=us-east-1
export AWS_BEARER_TOKEN_BEDROCK=...
```

You can also pass a Bedrock API key explicitly for native Converse:

```ts
const bedrock = createBedrock({
  region: "us-east-1",
  apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK
});
```

Long-term Bedrock API keys are best kept to exploration and development. For production applications, use short-term credentials or IAM-based AWS SDK authentication.

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

AWS's Mantle examples use `OPENAI_API_KEY` and `OPENAI_BASE_URL`; pass those values explicitly as `apiKey` and `baseURL` if you use that naming. The adapter does not read them automatically so a real OpenAI configuration is not accidentally reused for Bedrock.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
