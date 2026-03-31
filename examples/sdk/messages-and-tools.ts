import { assistant, generateText, system, textPart, tool, user } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

import { requiredEnv } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

const result = await generateText({
  model: openai("gpt-4o-mini"),
  messages: [
    system("You are a travel planner."),
    user("I want a short city break in Argentina this weekend."),
    assistant("I can help with that. Tell me your budget."),
    user([
      textPart("Budget: 500 USD. Also check the weather in "),
      textPart("Buenos Aires")
    ])
  ],
  tools: {
    get_weather: tool({
      name: "get_weather",
      description: "Returns a compact weather summary for a city.",
      schema: z.object({
        city: z.string()
      }),
      execute: ({ city }) => ({
        city,
        forecast: "Mild temperature with partial clouds",
        maxC: 24
      })
    })
  },
  maxSteps: 2
});

console.log(result.text);
console.log(result.toolResults);
