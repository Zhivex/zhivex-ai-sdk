import { generateText } from "@zhivex-ai/sdk";
import { createXAI, xAIWebSearchTool, xAIXSearchTool } from "@zhivex-ai/xai";

import { requiredEnv } from "../_shared";

const xai = createXAI({
  apiKey: requiredEnv("XAI_API_KEY")
});

const result = await generateText({
  model: xai("grok-4.5"),
  prompt: "What changed in the latest xAI model release? Cite current sources.",
  reasoning: { effort: "medium" },
  providerOptions: { conversationId: "xai-provider-example" },
  tools: {
    web: xAIWebSearchTool(),
    x: xAIXSearchTool()
  }
});

console.log(result.text);
