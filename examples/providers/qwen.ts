import { generateText } from "@zhivex-ai/sdk";
import { createQwen, type QwenRegion } from "@zhivex-ai/qwen";

import { requiredEnv } from "../_shared";

const qwen = createQwen({
  apiKey: requiredEnv("QWEN_API_KEY"),
  workspaceId: process.env.QWEN_WORKSPACE_ID,
  region: (process.env.QWEN_REGION as QwenRegion | undefined) ?? "singapore"
});

const result = await generateText({
  model: qwen("qwen3.7-plus"),
  prompt: "Say hello from the Qwen adapter."
});

console.log(result.text);
