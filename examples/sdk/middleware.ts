import {
  createCachedGenerateMiddleware,
  createCircuitBreakerMiddleware,
  createInMemoryGenerateCache,
  createTelemetryMiddleware,
  streamText,
  wrapLanguageModel
} from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

import { requiredEnv } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

const cache = createInMemoryGenerateCache();

const wrappedModel = wrapLanguageModel(openai("gpt-4o-mini"), [
  createTelemetryMiddleware({
    onEvent(event) {
      console.log(event.type, event.model.provider, event.model.modelId);
    }
  }),
  createCachedGenerateMiddleware({
    cache
  }),
  createCircuitBreakerMiddleware({
    failureThreshold: 3,
    cooldownMs: 10_000,
    onStateChange(state) {
      console.log("circuit", state.status, state.failures);
    }
  })
]);

const result = streamText({
  model: wrappedModel,
  prompt: "Explain middleware composition for a language model SDK."
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

const final = await result.collect();
console.log("\nfinish:", final.finishReason);
