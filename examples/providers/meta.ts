import { generateText } from "@zhivex-ai/sdk";
import { createMeta } from "@zhivex-ai/meta";

import { requiredEnv } from "../_shared";

const meta = createMeta({
  apiKey: requiredEnv("MODEL_API_KEY")
});

const result = await generateText({
  model: meta("muse-spark-1.1"),
  prompt: "Say hello from the Meta Model API adapter."
});

console.log(result.text);
