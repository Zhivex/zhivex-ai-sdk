import { z } from "zod";

import { createGateway } from "@zhivex-ai/gateway";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { createOpenAI } from "@zhivex-ai/openai";

import { requiredEnv, section } from "../_shared";

const gateway = createGateway({
  adapters: {
    openai: createOpenAI({ apiKey: requiredEnv("OPENAI_API_KEY") }),
    anthropic: createAnthropic({ apiKey: requiredEnv("ANTHROPIC_API_KEY") })
  }
});

section("Gateway Object");

const result = await gateway.generateObject({
  primary: { provider: "openai", modelId: "gpt-4o-mini" },
  fallbacks: [{ provider: "anthropic", modelId: "claude-3-5-sonnet" }],
  messages: [{ role: "user", content: "Return JSON with title and summary for routing." }],
  schema: z.object({
    title: z.string(),
    summary: z.string()
  }),
  mode: "auto"
});

console.log(result.object);
console.log(result.providerUsed, result.modelUsed);
