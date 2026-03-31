import { generateText } from "@zhivex-ai/sdk";
import { createAzureOpenAI } from "@zhivex-ai/azure-openai";

import { requiredEnv } from "../_shared";

const azure = createAzureOpenAI({
  apiKey: requiredEnv("AZURE_OPENAI_API_KEY"),
  endpoint: requiredEnv("AZURE_OPENAI_ENDPOINT")
});

const result = await generateText({
  model: azure("gpt-4o-mini"),
  prompt: "Say hello from the Azure OpenAI adapter."
});

console.log(result.text);
