import { generateText } from "@zhivex-ai/sdk";
import { createDeepSeek } from "@zhivex-ai/deepseek";

import { requiredEnv } from "../_shared";

const deepseek = createDeepSeek({
  apiKey: requiredEnv("DEEPSEEK_API_KEY")
});

const result = await generateText({
  model: deepseek("deepseek-v4-pro"),
  prompt: "Compare breadth-first search and depth-first search for pathfinding in three concise points.",
  reasoning: { effort: "max" },
  maxTokens: 512
});

const fim = await deepseek.fim.generate({
  prompt: "function binarySearch(values: number[], target: number) {\n",
  suffix: "\n}",
  maxTokens: 256
});

console.log(result.text);
console.log(fim.text);
