import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error("Set OPENAI_API_KEY in .env before running the first-response script.");
}

const openai = createOpenAI({ apiKey });
const startedAt = performance.now();
const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Reply with one short sentence confirming that Zhivex AI SDK is connected.",
  maxTokens: 64,
  timeoutMs: 30_000
});

console.log(result.text);
console.log(`FIRST_RESPONSE_OK ${Math.round(performance.now() - startedAt)}ms`);
