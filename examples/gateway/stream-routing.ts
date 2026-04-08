import { createGateway } from "@zhivex-ai/gateway";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { createOpenAI } from "@zhivex-ai/openai";

import { requiredEnv, section } from "../_shared";

const gateway = createGateway({
  adapters: {
    openai: createOpenAI({ apiKey: requiredEnv("OPENAI_API_KEY") }),
    anthropic: createAnthropic({ apiKey: requiredEnv("ANTHROPIC_API_KEY") })
  },
  maxRetries: 1
});

section("Gateway Stream");

const result = gateway.streamText({
  primary: { provider: "openai", modelId: "gpt-4o-mini" },
  fallbacks: [{ provider: "anthropic", modelId: "claude-3-5-sonnet" }],
  messages: [{ role: "user", content: "Explain why streaming fallback matters." }],
  routingMode: "balanced"
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

console.log("\n");
console.log(await result.collect());
