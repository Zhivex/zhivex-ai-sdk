import { generateText } from "@zhivex-ai/sdk";
import { createBedrock } from "@zhivex-ai/bedrock";

import { requiredEnv } from "../_shared";

const bedrock = createBedrock({
  region: requiredEnv("AWS_REGION")
});

const result = await generateText({
  model: bedrock("anthropic.claude-3-5-sonnet"),
  prompt: "Say hello from the Bedrock adapter."
});

console.log(result.text);
