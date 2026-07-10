import { describe, expect, it } from "vitest";

import { createApprovalPolicy, createMcpToolSet, streamText } from "../src/index.js";
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
    if (!("schema" in echo)) {
      throw new Error("Expected MCP tool schema.");
    }
    expect(echo.schema.safeParse({ value: 42 }).success).toBe(true);
    expect(echo.schema.safeParse({ value: "bad" }).success).toBe(true);
    expect(echo.metadata).toEqual({
      source: "mcp",
      originalName: "echo",
      inputSchema: null,
      annotations: null,
      advancedRegistry: {
        source: "mcp",
        permissions: ["external-side-effect"],
        audit: {
          riskLevel: "medium",
          description: "MCP tool requires approval because it is not explicitly read-only."
        }
      }
    });
    expect(echo.requiresApproval).toBe(true);
  });

  it("builds zod validation from MCP input schemas and preserves annotations", async () => {
    const tools = await createMcpToolSet({
      async listTools() {
        return {
          tools: [
            {
              name: "weather",
              description: "Get weather",
              inputSchema: {
                type: "object",
                properties: {
                  city: { type: "string", minLength: 2 },
                  days: { type: "integer", minimum: 1 }
                },
                required: ["city"],
                additionalProperties: false
              },
              annotations: {
                readOnlyHint: true,
                title: "Weather"
              }
            }
          ]
        };
      },
      async callTool(input) {
        return {
          structuredContent: input.arguments ?? {}
        };
      }
    });

    const weather = tools.weather;
    if (!weather || !("execute" in weather)) {
      throw new Error("Expected a callable MCP tool.");
    }

    expect(weather.schema.safeParse({ city: "Madrid", days: 2 }).success).toBe(true);
    expect(weather.schema.safeParse({ city: "M" }).success).toBe(false);
    expect(weather.schema.safeParse({ days: 2 }).success).toBe(false);
    expect(weather.schema.safeParse({ city: "Madrid", extra: true }).success).toBe(false);
    expect(weather.metadata).toEqual({
      source: "mcp",
      originalName: "weather",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string", minLength: 2 },
          days: { type: "integer", minimum: 1 }
        },
        required: ["city"],
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true,
        title: "Weather"
      },
      advancedRegistry: {
        source: "mcp",
        permissions: ["read"],
        audit: {
          riskLevel: "low",
          description: "MCP server declares this tool read-only."
        }
      }
    });
    expect(weather.requiresApproval).toBe(false);
  });

  it("uses safe unknown-schema fallbacks for unsupported MCP schemas", async () => {
    const tools = await createMcpToolSet({
      async listTools() {
        return {
          tools: [
            {
              name: "mystery",
              inputSchema: {
                type: "something-custom"
              }
            }
          ]
        };
      },
      async callTool(input) {
        return input.arguments ?? null;
      }
    });

    const mystery = tools.mystery;
    if (!mystery || !("execute" in mystery)) {
      throw new Error("Expected a callable MCP tool.");
    }

    expect(mystery.schema.safeParse({ any: "value" }).success).toBe(true);
    expect(mystery.requiresApproval).toBe(true);
  });

  it("requires approval for destructive and open-world MCP tools", async () => {
    const tools = await createMcpToolSet({
      async listTools() {
        return [{
          name: "archive_customer",
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: true
          }
        }];
      },
      async callTool() {
        return { ok: true };
      }
    });
    const archive = tools.archive_customer;
    if (!archive || !("execute" in archive)) {
      throw new Error("Expected a callable MCP tool.");
    }

    expect(archive.requiresApproval).toBe(true);
    const decision = await createApprovalPolicy({ preset: "review-sensitive" })({
      tool: archive,
      toolCall: { id: "call_1", name: archive.name, input: {} },
      input: {},
      step: 1,
      model: {} as never,
      request: { messages: [] }
    });
    expect(decision).toMatchObject({ approved: false });
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
