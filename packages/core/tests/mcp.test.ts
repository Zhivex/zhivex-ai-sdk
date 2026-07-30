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
      title: null,
      inputSchema: null,
      outputSchema: null,
      annotations: null,
      advancedRegistry: {
        source: "mcp",
        annotationsTrusted: false,
        permissions: ["external-side-effect"],
        audit: {
          riskLevel: "medium",
          description: "MCP tool requires approval because it is not explicitly trusted as read-only."
        }
      }
    });
    expect(echo.requiresApproval).toBe(true);
  });

  it("builds zod validation from MCP input schemas and preserves annotations", async () => {
    const tools = await createMcpToolSet(
      {
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
      },
      { trustServerToolAnnotations: true }
    );

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
      title: "Weather",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string", minLength: 2 },
          days: { type: "integer", minimum: 1 }
        },
        required: ["city"],
        additionalProperties: false
      },
      outputSchema: null,
      annotations: {
        readOnlyHint: true,
        title: "Weather"
      },
      advancedRegistry: {
        source: "mcp",
        annotationsTrusted: true,
        permissions: ["read"],
        audit: {
          riskLevel: "low",
          description: "Trusted MCP server annotations declare this tool read-only."
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

  it("does not trust read-only annotations unless explicitly configured", async () => {
    const tools = await createMcpToolSet({
      async listTools() {
        return [{
          name: "read_docs",
          annotations: { readOnlyHint: true }
        }];
      },
      async callTool() {
        return { content: [] };
      }
    });

    expect(tools.read_docs?.requiresApproval).toBe(true);
    expect(tools.read_docs?.metadata?.advancedRegistry).toMatchObject({
      annotationsTrusted: false,
      permissions: ["external-side-effect"]
    });
  });

  it("paginates tools/list with bounded opaque cursors", async () => {
    const requests: unknown[] = [];
    const tools = await createMcpToolSet({
      async listTools(input) {
        requests.push(input);
        if (!input) {
          return { tools: [{ name: "one" }], nextCursor: "cursor-a" };
        }
        if (input.cursor === "cursor-a") {
          return { tools: [{ name: "two" }], nextCursor: "" };
        }
        return { tools: [{ name: "three" }] };
      },
      async callTool() {
        return { content: [] };
      }
    });

    expect(Object.keys(tools)).toEqual(["one", "two", "three"]);
    expect(requests).toEqual([undefined, { cursor: "cursor-a" }, { cursor: "" }]);
  });

  it("rejects repeated cursors and listing limits", async () => {
    await expect(
      createMcpToolSet({
        async listTools() {
          return { tools: [{ name: "one" }], nextCursor: "same" };
        },
        async callTool() {
          return null;
        }
      })
    ).rejects.toThrow('repeated cursor "same"');

    await expect(
      createMcpToolSet(
        {
          async listTools() {
            return [{ name: "one" }, { name: "two" }];
          },
          async callTool() {
            return null;
          }
        },
        { maxListedTools: 1 }
      )
    ).rejects.toThrow("1-tool limit");

    await expect(
      createMcpToolSet(
        {
          async listTools() {
            return [];
          },
          async callTool() {
            return null;
          }
        },
        { maxListPages: 0 }
      )
    ).rejects.toThrow("positive safe integer");

    await expect(
      createMcpToolSet(
        {
          async listTools() {
            return [];
          },
          async callTool() {
            return null;
          }
        },
        { callToolTimeoutMs: 0 }
      )
    ).rejects.toThrow('"callToolTimeoutMs" option must be a positive safe integer');
  });

  it("validates structuredContent against MCP outputSchema", async () => {
    let mode: "valid" | "invalid" | "missing" | "error" = "valid";
    const tools = await createMcpToolSet({
      async listTools() {
        return [{
          name: "lookup",
          outputSchema: {
            type: "object",
            properties: {
              status: { type: "string" }
            },
            required: ["status"],
            additionalProperties: false
          }
        }];
      },
      async callTool() {
        if (mode === "valid") {
          return { structuredContent: { status: "ok" } };
        }
        if (mode === "invalid") {
          return { structuredContent: { status: 42 } };
        }
        if (mode === "missing") {
          return { content: [{ type: "text", text: "no structured value" }] };
        }
        return {
          isError: true,
          content: [{ type: "text", text: "remote failure" }]
        };
      }
    });
    const lookup = tools.lookup;
    if (!lookup || !("execute" in lookup)) {
      throw new Error("Expected a callable MCP tool.");
    }

    await expect(lookup.execute({})).resolves.toMatchObject({
      structuredContent: { status: "ok" }
    });
    mode = "invalid";
    await expect(lookup.execute({})).rejects.toThrow("structured output validation failed");
    mode = "missing";
    await expect(lookup.execute({})).rejects.toThrow("returned no structuredContent");
    mode = "error";
    await expect(lookup.execute({})).rejects.toThrow(
      'MCP tool "lookup" returned an error: remote failure'
    );
  });

  it("propagates abort, timeout, and idempotency to callTool", async () => {
    const callOptions: unknown[] = [];
    let shouldHang = false;
    const tools = await createMcpToolSet(
      {
        async listTools() {
          return [{ name: "write" }];
        },
        async callTool(_input, options) {
          callOptions.push(options);
          if (shouldHang) {
            return new Promise(() => {});
          }
          return { structuredContent: { ok: true } };
        }
      },
      { callToolTimeoutMs: 5 }
    );
    const write = tools.write;
    if (!write || !("execute" in write)) {
      throw new Error("Expected a callable MCP tool.");
    }

    await write.execute({}, {
      toolCall: { id: "call-1", name: "write", input: {} },
      step: 1,
      model: {} as never,
      idempotencyKey: "run:tool"
    });
    expect(callOptions[0]).toMatchObject({
      timeoutMs: 5,
      idempotencyKey: "run:tool",
      abortSignal: expect.any(AbortSignal)
    });

    shouldHang = true;
    await expect(write.execute({})).rejects.toThrow("timed out after 5ms");
  });

  it("honors a caller abort signal while listing tools", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));

    await expect(
      createMcpToolSet(
        {
          async listTools(_input, options) {
            expect(options?.abortSignal?.aborted).toBe(true);
            return new Promise(() => {});
          },
          async callTool() {
            return null;
          }
        },
        {
          abortSignal: controller.signal,
          listToolsTimeoutMs: 100
        }
      )
    ).rejects.toThrow("caller cancelled");
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
