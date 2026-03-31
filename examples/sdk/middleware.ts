import {
  createCachedGenerateMiddleware,
  createCircuitBreakerMiddleware,
  createInMemoryGenerateCache,
  createTelemetryMiddleware,
  generateText,
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

const result = await generateText({
  model: wrappedModel,
  prompt: "Explain middleware composition for a language model SDK."
});

console.log(result.text);
