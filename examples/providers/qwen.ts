import { generateText } from "@zhivex-ai/sdk";
import { createQwen } from "@zhivex-ai/qwen";

import { requiredEnv } from "../_shared";

const qwen = createQwen({
  apiKey: requiredEnv("QWEN_API_KEY")
});

const result = await generateText({
  model: qwen("qwen-plus"),
  prompt: "Say hello from the Qwen adapter."
});

console.log(result.text);
