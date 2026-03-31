import { generateText } from "@zhivex-ai/sdk";
import { createKimi } from "@zhivex-ai/kimi";

import { requiredEnv } from "../_shared";

const kimi = createKimi({
  apiKey: requiredEnv("KIMI_API_KEY")
});

const result = await generateText({
  model: kimi("kimi-k2-0905-preview"),
  prompt: "Say hello from the Kimi adapter."
});

console.log(result.text);
