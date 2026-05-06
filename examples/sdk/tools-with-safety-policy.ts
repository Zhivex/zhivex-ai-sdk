import {
  applySafetyPolicyToAgent,
  createAgent,
  createSafetyPolicy,
  runAgent,
  tool,
  type LanguageModel
} from "../../packages/sdk/src/index";
import { z } from "zod";

import { section } from "../_shared";

const capabilities: LanguageModel["capabilities"] = {
  streaming: false,
  tools: true,
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

let generateCalls = 0;

const model: LanguageModel = {
  provider: "example",
  modelId: "deterministic-tool-caller",
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
                  input: {
                    accountId: "acct_123"
                  }
                }
              }
            ]
          }
        ]
      };
    }

    return {
      text: "The account status is active.",
      finishReason: "stop",
      messages: [
        {
          role: "assistant",
          parts: [{ type: "text", text: "The account status is active." }]
        }
      ]
    };
  }
};

const baseAgent = createAgent({
  id: "safety-policy-example",
  model,
  maxSteps: 2,
  tools: {
    lookupAccount: tool({
      name: "lookupAccount",
      description: "Looks up an account status.",
      schema: z.object({
        accountId: z.string()
      }),
      execute: ({ accountId }) => ({
        accountId,
        status: "active"
      })
    })
  }
});

const agent = applySafetyPolicyToAgent(
  baseAgent,
  createSafetyPolicy({
    preset: "review-sensitive",
    redaction: {
      includeEmails: true
    },
    budget: {
      maxSteps: 2,
      maxToolCalls: 2,
      maxToolErrors: 1,
      maxTotalTokens: 1_000
    }
  })
);

section("Run agent with safety policy");
const result = await runAgent(agent, {
  userId: "user_123",
  prompt: "Check acct_123 for ana@example.com."
});

console.log(result.status);
console.log(result.outputText);
console.log(result.toolResults);
