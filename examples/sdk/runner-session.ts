import { createAgent, createFileSessionService, createRunner, getApiStability, type LanguageModel } from "@zhivex-ai/sdk";

import { section } from "../_shared";

const capabilities: LanguageModel["capabilities"] = {
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false
};

const model: LanguageModel = {
  provider: "example",
  modelId: "deterministic",
  capabilities,
  async generate(input) {
    const lastText =
      input.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .at(-1)?.text ?? "";

    return {
      text: `reply:${lastText}`,
      finishReason: "stop",
      messages: [
        {
          role: "assistant",
          parts: [{ type: "text", text: `reply:${lastText}` }]
        }
      ]
    };
  }
};

const agent = createAgent({
  id: "runner-session-example",
  model,
  instructions: "Return deterministic replies for local documentation examples."
});

const runner = createRunner({
  appName: "runner-session-example",
  agent,
  sessionService: createFileSessionService({
    directory: "./tmp/example-runner-sessions"
  })
});

section("Runner stability");
console.log(getApiStability("createRunner"));

section("First turn");
const first = await runner.run({
  userId: "user_123",
  sessionId: "demo",
  prompt: "hello"
});
console.log(first.output.outputText);

section("Second turn with persisted context");
const second = await runner.run({
  userId: "user_123",
  sessionId: first.session.sessionId,
  prompt: "again"
});
console.log(second.output.outputText);
console.log(second.session.events.map((event) => event.type));
