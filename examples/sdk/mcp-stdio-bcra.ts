import {
  Agent,
  createMcpToolRegistry,
  createTextMessage,
  toToolSet,
  type LanguageModel,
  type StreamEvent
} from "@zhivex-ai/sdk";
import { createMcpStdioClient } from "@zhivex-ai/sdk/mcp-stdio";

import { section } from "../_shared";

/**
 * Experimental stdio MCP client wired into an agent through the tool registry.
 *
 * Spawns the public read-only BCRA server (`npx -y mcp-bcra`) and allowlists
 * exchange-rate, variable, and entity tools. Debtor and cheque lookups are not
 * registered. Build the workspace before running so the `mcp-stdio` export resolves.
 *
 *   bun run build
 *   bun run examples/sdk/mcp-stdio-bcra.ts
 */

const allowedTools = [
  "get-bcra-fx-currencies",
  "get-bcra-fx-quotes",
  "get-bcra-fx-quote-by-currency",
  "get-bcra-variables",
  "get-bcra-var-hist",
  "get-bcra-metodologia",
  "get-bcra-entities"
];

const client = createMcpStdioClient({
  command: "npx",
  args: ["-y", "mcp-bcra"],
  timeoutMs: 30_000
});

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
  modelId: "bcra-stdio-example",
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
                  id: "call_fx",
                  name: "get-bcra-fx-quotes",
                  input: {}
                }
              }
            ]
          }
        ]
      };
    }

    return {
      text: "Reported the public BCRA exchange-rate quotes.",
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 },
      messages: [createTextMessage("assistant", "Reported the public BCRA exchange-rate quotes.")]
    };
  },
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "This example uses generate()." };
      yield { type: "finish", finishReason: "stop" };
    })();
  }
};

try {
  section("Register public BCRA tools");
  const registry = await createMcpToolRegistry(client, {
    includeTools: allowedTools,
    listToolsTimeoutMs: 20_000,
    callToolTimeoutMs: 20_000
  });
  const tools = toToolSet(registry) ?? {};
  const names = Object.keys(tools).sort();
  console.log(names.join("\n"));
  if (names.some((name) => /deudor|cheque|cuit|cuil/i.test(name))) {
    throw new Error("Refusing to register debtor or cheque tools.");
  }
  if (!names.includes("get-bcra-fx-quotes") || !names.includes("get-bcra-entities") || !names.includes("get-bcra-variables")) {
    throw new Error("Expected exchange-rate, variable, and entity tools from mcp-bcra.");
  }

  const agent = new Agent({
    id: "bcra-public-data",
    model,
    instructions: "Answer only with public BCRA exchange rates, variables, or entities.",
    maxSteps: 4,
    tools
  });

  section("Run agent");
  const waiting = await agent.run({
    prompt: "What exchange rates did BCRA publish? Use get-bcra-fx-quotes."
  });

  const result = waiting.status === "waiting_approval"
    ? await agent.resume({
        state: waiting.state,
        approvals: waiting.state.pendingApprovals.map((request) => ({
          provider: request.provider,
          approvalRequestId: request.id,
          approve: true
        }))
      })
    : waiting;

  console.log("status:", result.status);
  console.log("text:", result.outputText);
  console.log("tools:", result.toolResults.map((entry) => entry.toolName));
} finally {
  await client.close();
}
