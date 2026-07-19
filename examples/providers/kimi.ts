import { generateText } from "@zhivex-ai/sdk";
import { createKimi } from "@zhivex-ai/kimi";

import { requiredEnv } from "../_shared";

const kimi = createKimi({
  apiKey: requiredEnv("KIMI_API_KEY")
});

const result = await generateText({
  model: kimi("kimi-k3"),
  prompt: "Say hello from Kimi K3 and explain your strongest use case in one sentence.",
  reasoning: { effort: "max" },
  maxTokens: 512
});

console.log(result.text);
