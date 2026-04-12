import { describe, expect, it } from "vitest";

import { createMcpToolSet, streamText } from "../src/index.js";
import type { LanguageModel, StreamEvent } from "../src/index.js";

describe("mcp helpers", () => {
  it("creates callable tools from an MCP client", async () => {
    const calls: Array<{ name: string; arguments: unknown }> = [];
    const tools = await createMcpToolSet({
      async listTools() {
        return {
          tools: [
            {
              name: "echo",
              description: "Echoes a value"
            }
          ]
        };
      },
      async callTool(input) {
        calls.push(input);
        return {
          content: [{ type: "text", text: "hello" }],
          structuredContent: { echoed: input.arguments },
          isError: false
        };
      }
    });

    const echo = tools.echo;
    if (!echo || !("execute" in echo)) {
      throw new Error("Expected a callable MCP tool.");
    }

    const result = await echo.execute({ value: 42 });
    expect(calls).toEqual([{ name: "echo", arguments: { value: 42 } }]);
    expect(result).toEqual({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { echoed: { value: 42 } },
      isError: false
    });
  });

  it("preserves provider-data events in streamed assistant messages", async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "stream",
      capabilities: {
        streaming: true,
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
      },
      async generate() {
        throw new Error("unused");
      },
      async stream() {
        return (async function* (): AsyncGenerator<StreamEvent> {
          yield {
            type: "provider-data",
            provider: "openai",
            data: {
              type: "mcp_approval_request",
              id: "req_1",
              arguments: "{}",
              name: "fetch_doc",
              server_label: "docs"
            }
          };
          yield { type: "text-delta", textDelta: "awaiting approval" };
          yield { type: "finish", finishReason: "stop" };
        })();
      }
    };

    const result = streamText({
      model,
      prompt: "hello"
    });

    const final = await result.collect();
    const assistantMessage = final.messages.at(-1);
    expect(assistantMessage?.parts).toEqual([
      { type: "text", text: "awaiting approval" },
      {
        type: "provider-data",
        provider: "openai",
        data: {
          type: "mcp_approval_request",
          id: "req_1",
          arguments: "{}",
          name: "fetch_doc",
          server_label: "docs"
        }
      }
    ]);
  });
});
