import { generateText } from "@zhivex-ai/sdk";
import {
  createQwen,
  QWEN_TOKEN_PLAN_BASE_URL,
  type QwenRegion
} from "@zhivex-ai/qwen";

import { requiredEnv } from "../_shared";

const tokenPlanApiKey = process.env.QWEN_TOKEN_PLAN_API_KEY;
const qwen = tokenPlanApiKey
  ? createQwen({
      apiKey: tokenPlanApiKey,
      baseURL: QWEN_TOKEN_PLAN_BASE_URL
    })
  : createQwen({
      apiKey: requiredEnv("QWEN_API_KEY"),
      workspaceId: process.env.QWEN_WORKSPACE_ID,
      region: (process.env.QWEN_REGION as QwenRegion | undefined) ?? "singapore"
    });

const result = await generateText({
  model: qwen(tokenPlanApiKey ? "qwen3.8-max-preview" : "qwen3.7-plus"),
  prompt: "Say hello from the Qwen adapter."
});

console.log(result.text);
