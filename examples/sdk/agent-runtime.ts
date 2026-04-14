import { createAgent, runAgent, tool } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

import { requiredEnv, section } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

const travelAgent = createAgent({
  model: openai("gpt-4o-mini"),
  instructions: "You are a concise travel assistant. Use tools when they add confidence.",
  maxSteps: 3,
  tools: {
    get_weather: tool({
      name: "get_weather",
      description: "Returns a compact weather summary for a city.",
      schema: z.object({
        city: z.string()
      }),
      execute: async ({ city }) => ({
        city,
        forecast: "Mild and sunny",
        maxC: 24
      })
    })
  }
});

section("Run agent");

const result = await runAgent(travelAgent, {
  prompt: "Plan a short afternoon in Buenos Aires and check the weather first."
});

console.log("status:", result.status);
console.log("text:", result.outputText);
console.log("steps:", result.steps.length);
console.log("tool results:", result.toolResults);
console.log("state summary:", {
  provider: result.state.provider,
  modelId: result.state.modelId,
  currentStep: result.state.currentStep,
  pendingApprovals: result.state.pendingApprovals.length
});
