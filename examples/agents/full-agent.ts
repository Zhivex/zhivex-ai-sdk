import {
  Agent,
  tool,
  type LanguageModel
} from "../../packages/agents/src/index";
import { z } from "zod";

import { section } from "../_shared";

const model: LanguageModel = {
  provider: "example",
  modelId: "agents-package-deterministic",
  capabilities: {
    streaming: false,
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
  },
  async generate(input) {
    const hasToolResult = input.messages.some((message) =>
      message.parts.some((part) => part.type === "tool-result")
    );

    if (!hasToolResult) {
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
                  name: "lookupTicket",
                  input: { ticketId: "ticket_123" }
                }
              }
            ]
          }
        ]
      };
    }

    return {
      text: "Ticket ticket_123 is ready for a concise customer reply.",
      finishReason: "stop",
      messages: [
        {
          role: "assistant",
          parts: [{ type: "text", text: "Ticket ticket_123 is ready for a concise customer reply." }]
        }
      ]
    };
  }
};

const agent = new Agent({
  id: "agents-package-example",
  model,
  instructions: "Use tools before answering support questions.",
  maxSteps: 3,
  tools: {
    lookupTicket: tool({
      name: "lookupTicket",
      schema: z.object({ ticketId: z.string() }),
      execute: async ({ ticketId }) => ({
        ticketId,
        customer: "Acme",
        severity: "normal"
      })
    })
  }
});

section("Run");
const result = await agent.run({
  prompt: "Prepare the next action for ticket_123."
});

console.log({
  status: result.status,
  outputText: result.outputText,
  steps: result.steps.length,
  toolResults: result.toolResults
});
