import { vi } from "vitest";
import { runChatCompletionsStreamContract } from "../../core/tests/chat-completions-contract.js";
import { createOpenAI } from "../src/index.js";

runChatCompletionsStreamContract(async (response) => {
  const model = createOpenAI({ apiKey: "test", fetch: vi.fn().mockResolvedValue(response) })("gpt-4.1-nano");
  return model.stream!({
    messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    providerOptions: { apiMode: "chat" }
  });
});
