import { embed } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

import { requiredEnv } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

const result = await embed({
  model: openai.embeddingModel!("text-embedding-3-small"),
  value: [
    "Unified SDK for LLM providers",
    "Provider adapters with a shared contract"
  ]
});

console.log(result.values);
console.log(result.embeddings.length);
console.log(result.embeddings[0]?.slice(0, 8));
