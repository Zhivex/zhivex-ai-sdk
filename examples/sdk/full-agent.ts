import {
  Agent,
  createTextMessage,
  getApiStability,
  tool,
  type LanguageModel,
  type StreamEvent
} from "../../packages/sdk/src/index";
import { z } from "zod";

import { section } from "../_shared";

const capabilities: LanguageModel["capabilities"] = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false
};

let generateCalls = 0;

const model: LanguageModel = {
  provider: "example",
  modelId: "full-agent-deterministic",
  capabilities,
  async generate() {
    generateCalls += 1;

    if (generateCalls === 1) {
      return {
        finishReason: "tool-calls",
        messages: [
          {
            role: "assistant",
            parts: [
              {
                type: "tool-call",
                toolCall: {
                  id: "call_1",
                  name: "lookupAccount",
                  input: { accountId: "acct_123" }
                }
              }
            ]
          }
        ]
      };
    }

    return {
      text: "Account acct_123 is active with no open risk flags.",
      finishReason: "stop",
      usage: { inputTokens: 42, outputTokens: 12, totalTokens: 54 },
      messages: [createTextMessage("assistant", "Account acct_123 is active with no open risk flags.")]
    };
  },
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "Streaming agent response." };
      yield { type: "finish", finishReason: "stop" };
    })();
  }
};

const agent = new Agent({
  id: "full-agent-example",
  model,
  instructions: "Use tools for account facts and return concise operational answers.",
  maxSteps: 3,
  tools: {
    lookupAccount: tool({
      name: "lookupAccount",
      description: "Reads a deterministic account record from an app-owned system.",
      schema: z.object({ accountId: z.string() }),
      execute: async ({ accountId }) => ({
        accountId,
        status: "active",
        riskFlags: []
      })
    })
  },
  metadata: { example: "full-agent" }
});

section("Stable Agent API");
console.log(getApiStability("Agent"));

section("Tool-using run");
const run = await agent.run({
  prompt: "Check account acct_123."
});
console.log({
  status: run.status,
  outputText: run.outputText,
  steps: run.steps.length,
  toolResults: run.toolResults
});

section("Serializable state");
console.log({
  runId: run.state.runId,
  agentId: run.state.agentId,
  currentStep: run.state.currentStep,
  provider: run.state.provider,
  modelId: run.state.modelId
});

section("Streaming");
const streamed = agent.stream({
  prompt: "Stream a short status update."
});
for await (const chunk of streamed.textStream) {
  console.log(chunk);
}
