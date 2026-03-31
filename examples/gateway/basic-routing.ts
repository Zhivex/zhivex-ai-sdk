import { defaultModelCatalog } from "@zhivex-ai/sdk";
import { createGateway } from "@zhivex-ai/gateway";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { createOpenAI } from "@zhivex-ai/openai";

import { requiredEnv } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

const anthropic = createAnthropic({
  apiKey: requiredEnv("ANTHROPIC_API_KEY")
});

const gateway = createGateway({
  adapters: {
    openai,
    anthropic
  },
  modelCatalog: defaultModelCatalog,
  latencyBiasMs: {
    openai: 100,
    anthropic: 250
  },
  onAttempt(attempt) {
    console.log("attempt", attempt.provider, attempt.modelId, attempt.ok, attempt.retry);
  }
});

const result = await gateway.generate({
  systemPrompt: "Be concise and technical.",
  messages: [
    {
      role: "user",
      content: "Choose the best adapter for a tool-heavy support workflow."
    }
  ],
  routingMode: "balanced",
  taskIntent: "tool-heavy",
  requiredCapabilities: {
    tools: true
  },
  primary: {
    provider: "openai",
    modelId: "gpt-4o-mini"
  },
  fallbacks: [
    {
      provider: "anthropic",
      modelId: "claude-3-5-sonnet"
    }
  ]
});

console.log(result.text);
console.log(result.providerUsed, result.modelUsed);
console.log(result.routeDecision);
