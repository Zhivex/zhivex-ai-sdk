import { createAgent, streamAgent, toUIAgentStreamResponse, tool } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

import { requiredEnv, section } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

const weatherAgent = createAgent({
  model: openai("gpt-4o-mini"),
  instructions: "Answer briefly and call tools when needed.",
  maxSteps: 3,
  tools: {
    weather: tool({
      name: "weather",
      schema: z.object({
        city: z.string()
      }),
      execute: async ({ city }) => ({
        city,
        forecast: "Sunny",
        maxC: 26
      })
    })
  }
});

section("Inspect agent event stream");

const streamed = streamAgent(weatherAgent, {
  prompt: "What's the weather in Madrid and what should I wear?"
});

for await (const event of streamed.eventStream) {
  if (event.type === "agent-run-start") {
    console.log("run started:", event.currentStep, "/", event.maxSteps);
  }

  if (event.type === "agent-step-start") {
    console.log("step started:", event.stepIndex);
  }

  if (event.type === "text-delta") {
    process.stdout.write(event.textDelta);
  }

  if (event.type === "agent-run-finish") {
    console.log("\nrun finished:", event.status);
  }
}

const final = await streamed.collect();
console.log("final text:", final.outputText);

section("Create SSE response for a UI");

const uiResponse = toUIAgentStreamResponse(
  streamAgent(weatherAgent, {
    prompt: "Give me a one-line weather summary for Madrid."
  }),
  {
    messageId: "agent_1"
  }
);

console.log(uiResponse.status);
console.log(uiResponse.headers.get("content-type"));
