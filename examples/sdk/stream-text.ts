import { streamText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

import { requiredEnv, section } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

const result = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Write a short release note for a new provider-agnostic AI SDK."
});

section("textStream");
for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

const final = await result.collect();
section("final");
console.log(final.finishReason);
console.log(final.usage);
