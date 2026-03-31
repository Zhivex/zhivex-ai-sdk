import {
  streamText,
  toTextStreamResponse,
  toUIMessageStreamResponse
} from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

import { requiredEnv } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

const textResult = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Return a short plain-text answer."
});

const textResponse = toTextStreamResponse(textResult, {
  headers: {
    "x-example": "text"
  }
});

console.log(textResponse.status);
console.log(textResponse.headers.get("content-type"));

const uiResult = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Return a short answer for a chat UI."
});

const uiResponse = toUIMessageStreamResponse(uiResult, {
  messageId: "assistant_1"
});

console.log(uiResponse.status);
console.log(uiResponse.headers.get("content-type"));
