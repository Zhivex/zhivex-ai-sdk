import { describe, expect, it } from "vitest";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import {
  assistant,
  createCachedGenerateMiddleware,
  createCircuitBreakerMiddleware,
  createFileGenerateCache,
  createInMemoryGenerateCache,
  createModelCatalog,
  createTelemetryMiddleware,
  createToolRegistry,
  createTextMessage,
  createUIMessageJsonResponse,
  createUIMessageLinesResponse,
  embed,
  embedMany,
  getAgentCapabilities,
  getAgentSupportTier,
  getHostedToolClass,
  parseUIMessageRequest,
  generateObject,
  generateText,
  hostedTool,
  isHostedToolClass,
  createMcpToolRegistry,
  streamObject,
  streamText,
  system,
  toSSEResponse,
  toTextStreamResponse,
  toUIMessage,
  toUIMessageStream,
  toUIMessageStreamResponse,
  wrapLanguageModel,
  tool,
  toToolSet,
  user
} from "../src/index.js";
import type { EmbeddingModel, LanguageModel, StreamEvent, ToolSet } from "../src/index.js";
import { UnsupportedFeatureError, ValidationError } from "../src/index.js";

const createLanguageModel = (overrides?: Partial<LanguageModel>): LanguageModel => ({
  provider: "test",
  modelId: "model",
  capabilities: {
    streaming: true,
    tools: true,
    structuredOutput: true,
    jsonMode: true,
    toolChoice: true,
    parallelToolCalls: false,
    vision: true,
    files: false,
    audioInput: false,
    audioOutput: false,
    embeddings: false,
    reasoning: false,
    webSearch: false
  },
  async generate() {
    return { messages: [createTextMessage("assistant", "hello world")], text: "hello world" };
  },
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "hello" };
      yield { type: "text-delta", textDelta: " world" };
      yield { type: "finish", finishReason: "stop" };
    })();
  },
  ...overrides
});

const createEmbeddingModel = (overrides?: Partial<EmbeddingModel>): EmbeddingModel => ({
  provider: "test",
  modelId: "embed",
  capabilities: {
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
    embeddings: true,
    reasoning: false,
    webSearch: false
  },
  async embed() {
    return {
      embeddings: [[0.1, 0.2]]
    };
  },
  ...overrides
});

describe("core helpers", () => {
  it("generates text from prompt", async () => {
    const result = await generateText({
      model: createLanguageModel(),
      prompt: "Say hi"
    });

    expect(result.text).toBe("hello world");
    expect(result.messages.at(-1)?.role).toBe("assistant");
  });

  it("passes reasoning config to the common request", async () => {
    const result = await generateText({
      model: createLanguageModel({
        capabilities: {
          streaming: true,
          tools: true,
          structuredOutput: true,
          jsonMode: true,
          toolChoice: true,
          parallelToolCalls: false,
          vision: true,
          files: false,
          audioInput: false,
          audioOutput: false,
          embeddings: false,
          reasoning: true,
          webSearch: false
        },
        async generate(input) {
          expect(input.reasoning).toEqual({ effort: "medium", budgetTokens: 512 });
          return { messages: [createTextMessage("assistant", "reasoned")], text: "reasoned" };
        }
      }),
      prompt: "Think carefully",
      reasoning: {
        effort: "medium",
        budgetTokens: 512
      }
    });

    expect(result.text).toBe("reasoned");
  });

  it("rejects prompt and messages used together", async () => {
    await expect(
      generateText({
        model: createLanguageModel(),
        prompt: "Say hi",
        messages: [user("Hello")]
      })
    ).rejects.toThrow('Pass either "prompt" or "messages", but not both.');
  });

  it("rejects reasoning for models without reasoning support", async () => {
    await expect(
      generateText({
        model: createLanguageModel(),
        prompt: "Say hi",
        reasoning: {
          effort: "low"
        }
      })
    ).rejects.toThrow('Model "test/model" does not support reasoning.');
  });

  it("rejects empty reasoning config", async () => {
    await expect(
      generateText({
        model: createLanguageModel({
          capabilities: {
            streaming: true,
            tools: true,
            structuredOutput: true,
            jsonMode: true,
            toolChoice: true,
            parallelToolCalls: false,
            vision: true,
            files: false,
            audioInput: false,
            audioOutput: false,
            embeddings: false,
            reasoning: true,
            webSearch: false
          }
        }),
        prompt: "Say hi",
        reasoning: {}
      })
    ).rejects.toThrow('The "reasoning" config must include at least one supported field.');
  });

  it("rejects invalid reasoning budget tokens", async () => {
    await expect(
      generateText({
        model: createLanguageModel({
          capabilities: {
            streaming: true,
            tools: true,
            structuredOutput: true,
            jsonMode: true,
            toolChoice: true,
            parallelToolCalls: false,
            vision: true,
            files: false,
            audioInput: false,
            audioOutput: false,
            embeddings: false,
            reasoning: true,
            webSearch: false
          }
        }),
        prompt: "Say hi",
        reasoning: {
          budgetTokens: 0
        }
      })
    ).rejects.toThrow('The "reasoning.budgetTokens" field must be a positive integer.');
  });

  it("passes tool choice through to the common request", async () => {
    const result = await generateText({
      model: createLanguageModel({
        async generate(input) {
          expect(input.toolChoice).toEqual({
            type: "tool",
            toolName: "weather"
          });
          return { messages: [createTextMessage("assistant", "tool selected")], text: "tool selected" };
        }
      }),
      prompt: "Weather?",
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      },
      toolChoice: {
        type: "tool",
        toolName: "weather"
      }
    });

    expect(result.text).toBe("tool selected");
  });

  it("infers hosted tool classes and exposes hosted tool helpers", () => {
    const web = hostedTool({
      name: "web",
      provider: "openai",
      type: "web_search"
    });
    const files = hostedTool({
      name: "files",
      provider: "openai",
      type: "file_search"
    });
    const mcp = hostedTool({
      name: "mcp",
      provider: "openai",
      type: "mcp"
    });
    const shell = hostedTool({
      name: "shell",
      provider: "openai",
      type: "shell"
    });
    const applyPatch = hostedTool({
      name: "apply_patch",
      provider: "openai",
      type: "apply_patch"
    });
    const toolSearch = hostedTool({
      name: "tool_search",
      provider: "openai",
      type: "tool_search"
    });
    const webExtractor = hostedTool({
      name: "web_extractor",
      provider: "qwen",
      type: "web_extractor"
    });
    const skill = hostedTool({
      name: "skill",
      provider: "openai",
      type: "skill_tool"
    });

    expect(getHostedToolClass(web)).toBe("web-search");
    expect(getHostedToolClass(files)).toBe("file-search");
    expect(getHostedToolClass(mcp)).toBe("remote-mcp");
    expect(getHostedToolClass(shell)).toBe("shell");
    expect(getHostedToolClass(applyPatch)).toBe("apply-patch");
    expect(getHostedToolClass(toolSearch)).toBe("tool-search");
    expect(getHostedToolClass(webExtractor)).toBe("web-extraction");
    expect(getHostedToolClass(skill)).toBe("skill");
    expect(isHostedToolClass(web, "web-search")).toBe(true);
    expect(isHostedToolClass(files, "web-search")).toBe(false);
  });

  it("creates composable tool registries and converts them back to tool sets", () => {
    const registry = createToolRegistry({
      weather: tool({
        name: "weather",
        schema: z.object({ city: z.string() }),
        execute: ({ city }) => ({ city, forecast: "sunny" })
      })
    });

    const merged = registry.merge({
      web: hostedTool({
        name: "web",
        provider: "openai",
        type: "web_search"
      })
    });

    expect(merged.has("weather")).toBe(true);
    expect(merged.has("web")).toBe(true);
    expect(Object.keys(toToolSet(merged) ?? {})).toEqual(["weather", "web"]);
  });

  it("creates MCP tool registries from an MCP client", async () => {
    const registry = await createMcpToolRegistry({
      async listTools() {
        return {
          tools: [
            {
              name: "search_docs",
              description: "Search docs",
              inputSchema: {
                type: "object",
                properties: {
                  query: {
                    type: "string"
                  }
                },
                required: ["query"]
              }
            }
          ]
        };
      },
      async callTool() {
        return { result: "ok" };
      }
    });

    expect(registry.has("search_docs")).toBe(true);
    expect(registry.get("search_docs")).toMatchObject({
      name: "search_docs"
    });
  });

  it("returns defaulted agent capabilities for models", () => {
    const capabilities = getAgentCapabilities(createLanguageModel());

    expect(capabilities).toEqual({
      supportTier: "tier-c",
      toolChoiceNone: false,
      approvalRequests: false,
      hostedWebSearch: false,
      hostedFileSearch: false,
      remoteMcp: false,
      computerUse: false,
      codeExecution: false,
      shell: false,
      applyPatch: false,
      toolSearch: false,
      webExtraction: false,
      skills: false,
      toolsets: false
    });
  });

  it("returns the normalized agent support tier for models", () => {
    expect(getAgentSupportTier(createLanguageModel())).toBe("tier-c");
  });

  it("rejects tool choice for models without tool choice support", async () => {
    await expect(
      generateText({
        model: createLanguageModel({
          capabilities: {
            streaming: true,
            tools: true,
            structuredOutput: true,
            jsonMode: true,
            toolChoice: false,
            parallelToolCalls: false,
            vision: true,
            files: false,
            audioInput: false,
            audioOutput: false,
            embeddings: false,
            reasoning: false,
            webSearch: false
          }
        }),
        prompt: "Weather?",
        tools: {
          weather: tool({
            name: "weather",
            schema: z.object({ city: z.string() }),
            execute: ({ city }) => ({ city, forecast: "sunny" })
          })
        },
        toolChoice: "required"
      })
    ).rejects.toThrow('Model "test/model" does not support tool choice.');
  });

  it("rejects tool choice without registered tools", async () => {
    await expect(
      generateText({
        model: createLanguageModel(),
        prompt: "Weather?",
        toolChoice: "required"
      })
    ).rejects.toThrow('The "toolChoice" option requires at least one registered tool.');
  });

  it("rejects selecting an unregistered tool", async () => {
    await expect(
      generateText({
        model: createLanguageModel(),
        prompt: "Weather?",
        tools: {
          weather: tool({
            name: "weather",
            schema: z.object({ city: z.string() }),
            execute: ({ city }) => ({ city, forecast: "sunny" })
          })
        },
        toolChoice: {
          type: "tool",
          toolName: "news"
        }
      })
    ).rejects.toThrow('The selected tool "news" is not registered.');
  });

  it("rejects executing provider-hosted tools in the local tool loop", async () => {
    const model = createLanguageModel({
      async generate() {
        return {
          messages: [
            {
              role: "assistant",
              parts: [{ type: "tool-call", toolCall: { id: "1", name: "web", input: { query: "weather" } } }]
            }
          ]
        };
      }
    });

    await expect(
      generateText({
        model,
        prompt: "Search the web",
        maxSteps: 2,
        tools: {
          web: hostedTool({
            name: "web",
            provider: "openai",
            type: "web_search"
          })
        }
      })
    ).rejects.toThrow('Tool "web" is provider-hosted and cannot be executed by the local tool loop.');
  });

  it("applies tool approval policies before local tool execution", async () => {
    let call = 0;
    const model = createLanguageModel({
      async generate() {
        call += 1;
        if (call === 1) {
          return {
            messages: [
              {
                role: "assistant",
                parts: [{ type: "tool-call", toolCall: { id: "1", name: "weather", input: { city: "Madrid" } } }]
              }
            ],
            finishReason: "tool-calls"
          };
        }

        return { messages: [createTextMessage("assistant", "done")], text: "done" };
      }
    });

    const decisions: string[] = [];
    const result = await generateText({
      model,
      prompt: "Weather?",
      maxSteps: 2,
      toolApprovalPolicy(request) {
        decisions.push(request.toolCall.name);
        return {
          approved: false,
          reason: "Approval denied for tests."
        };
      },
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      }
    });

    expect(decisions).toEqual(["weather"]);
    expect(result.toolResults[0]).toMatchObject({
      toolName: "weather",
      isError: true,
      error: {
        message: "Approval denied for tests."
      }
    });
  });

  it("blocks tools marked as requiring approval when no policy is configured", async () => {
    let call = 0;
    const model = createLanguageModel({
      async generate() {
        call += 1;
        if (call === 1) {
          return {
            messages: [
              {
                role: "assistant",
                parts: [{ type: "tool-call", toolCall: { id: "1", name: "shell", input: { cmd: "pwd" } } }]
              }
            ],
            finishReason: "tool-calls"
          };
        }

        return { messages: [createTextMessage("assistant", "done")], text: "done" };
      }
    });

    const result = await generateText({
      model,
      prompt: "Run shell",
      maxSteps: 2,
      tools: {
        shell: tool({
          name: "shell",
          requiresApproval: true,
          schema: z.object({ cmd: z.string() }),
          execute: ({ cmd }) => ({ cmd })
        })
      }
    });

    expect(result.toolResults[0]?.isError).toBe(true);
    expect(result.toolResults[0]?.error?.message).toContain("requires approval");
  });

  it("executes tools across multiple steps", async () => {
    let call = 0;
    const tools: ToolSet = {
      weather: tool({
        name: "weather",
        schema: z.object({ city: z.string() }),
        execute: ({ city }) => ({ city, forecast: "sunny" })
      })
    };

    const model = createLanguageModel({
      async generate() {
        call += 1;
        if (call === 1) {
          return {
            messages: [
              {
                role: "assistant",
                parts: [{ type: "tool-call", toolCall: { id: "1", name: "weather", input: { city: "Madrid" } } }]
              }
            ]
          };
        }

        return { messages: [createTextMessage("assistant", "Madrid is sunny.")], text: "Madrid is sunny." };
      }
    });

    const result = await generateText({
      model,
      prompt: "Weather?",
      tools,
      maxSteps: 2
    });

    expect(result.text).toBe("Madrid is sunny.");
    expect(result.toolResults).toHaveLength(1);
    expect(result.messages.at(-3)?.role).toBe("assistant");
    expect(result.messages.at(-2)?.role).toBe("tool");
    expect(result.messages.at(-1)?.role).toBe("assistant");
  });

  it("executes tool calls in parallel while preserving result order", async () => {
    let call = 0;
    let active = 0;
    let maxActive = 0;

    const model = createLanguageModel({
      capabilities: {
        streaming: true,
        tools: true,
        structuredOutput: true,
        jsonMode: true,
        toolChoice: true,
        parallelToolCalls: true,
        vision: true,
        files: false,
        audioInput: false,
        audioOutput: false,
        embeddings: false,
        reasoning: false,
        webSearch: false
      },
      async generate() {
        call += 1;
        if (call === 1) {
          return {
            messages: [
              {
                role: "assistant",
                parts: [
                  { type: "tool-call", toolCall: { id: "1", name: "slow", input: { value: 1 } } },
                  { type: "tool-call", toolCall: { id: "2", name: "fast", input: { value: 2 } } }
                ]
              }
            ]
          };
        }

        return { messages: [createTextMessage("assistant", "done")], text: "done" };
      }
    });

    const result = await generateText({
      model,
      prompt: "Run both tools",
      maxSteps: 2,
      tools: {
        slow: tool({
          name: "slow",
          schema: z.object({ value: z.number() }),
          async execute({ value }) {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return { value };
          }
        }),
        fast: tool({
          name: "fast",
          schema: z.object({ value: z.number() }),
          async execute({ value }) {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return { value };
          }
        })
      }
    });

    expect(maxActive).toBeGreaterThan(1);
    expect(result.toolResults.map((entry) => entry.toolName)).toEqual(["slow", "fast"]);
  });

  it("limits parallel tool execution with maxConcurrency", async () => {
    let call = 0;
    let active = 0;
    let maxActive = 0;

    const model = createLanguageModel({
      capabilities: {
        streaming: true,
        tools: true,
        structuredOutput: true,
        jsonMode: true,
        toolChoice: true,
        parallelToolCalls: true,
        vision: true,
        files: false,
        audioInput: false,
        audioOutput: false,
        embeddings: false,
        reasoning: false,
        webSearch: false
      },
      async generate() {
        call += 1;
        if (call === 1) {
          return {
            messages: [
              {
                role: "assistant",
                parts: [
                  { type: "tool-call", toolCall: { id: "1", name: "one", input: {} } },
                  { type: "tool-call", toolCall: { id: "2", name: "two", input: {} } }
                ]
              }
            ]
          };
        }

        return { messages: [createTextMessage("assistant", "done")], text: "done" };
      }
    });

    await generateText({
      model,
      prompt: "Run tools",
      maxSteps: 2,
      toolExecution: {
        maxConcurrency: 1
      },
      tools: {
        one: tool({
          name: "one",
          schema: z.object({}),
          async execute() {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active -= 1;
            return { ok: true };
          }
        }),
        two: tool({
          name: "two",
          schema: z.object({}),
          async execute() {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active -= 1;
            return { ok: true };
          }
        })
      }
    });

    expect(maxActive).toBe(1);
  });

  it("turns tool timeouts into error results and can stop on tool error", async () => {
    let call = 0;
    const model = createLanguageModel({
      capabilities: {
        streaming: true,
        tools: true,
        structuredOutput: true,
        jsonMode: true,
        toolChoice: true,
        parallelToolCalls: true,
        vision: true,
        files: false,
        audioInput: false,
        audioOutput: false,
        embeddings: false,
        reasoning: false,
        webSearch: false
      },
      async generate() {
        call += 1;
        if (call === 1) {
          return {
            messages: [
              {
                role: "assistant",
                parts: [{ type: "tool-call", toolCall: { id: "1", name: "slow", input: {} } }]
              }
            ]
          };
        }

        return { messages: [createTextMessage("assistant", "done")], text: "done" };
      }
    });

    const timeoutResult = await generateText({
      model,
      prompt: "Run slow tool",
      maxSteps: 2,
      toolExecution: {
        timeoutMs: 5
      },
      tools: {
        slow: tool({
          name: "slow",
          schema: z.object({}),
          async execute() {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { ok: true };
          }
        })
      }
    });

    expect(timeoutResult.toolResults[0]).toMatchObject({
      toolName: "slow",
      isError: true
    });

    call = 0;
    await expect(
      generateText({
        model,
        prompt: "Run slow tool",
        maxSteps: 2,
        toolExecution: {
          timeoutMs: 5,
          stopOnError: true
        },
        tools: {
          slow: tool({
            name: "slow",
            schema: z.object({}),
            async execute() {
              await new Promise((resolve) => setTimeout(resolve, 20));
              return { ok: true };
            }
          })
        }
      })
    ).rejects.toThrow('Tool "slow" failed: Tool execution timed out after 5ms.');
  });

  it("builds ergonomic messages", () => {
    expect(system("You are helpful")).toEqual({
      role: "system",
      parts: [{ type: "text", text: "You are helpful" }]
    });
    expect(user("Hello")).toEqual(createTextMessage("user", "Hello"));
    expect(assistant([{ type: "text", text: "Hi" }])).toEqual({
      role: "assistant",
      parts: [{ type: "text", text: "Hi" }]
    });
  });

  it("validates structured output in native mode", async () => {
    const result = await generateObject({
      model: createLanguageModel({
        async generate(input) {
          expect(input.structuredOutput).toMatchObject({ mode: "native", name: "recipe" });
          return {
            messages: [createTextMessage("assistant", JSON.stringify({ title: "Soup", servings: 2 }))],
            text: JSON.stringify({ title: "Soup", servings: 2 })
          };
        }
      }),
      prompt: "Generate JSON",
      schema: z.object({
        title: z.string(),
        servings: z.number()
      }),
      schemaName: "recipe",
      mode: "native"
    });

    expect(result.object.title).toBe("Soup");
    expect(result.objectMode).toBe("native");
  });

  it("falls back to prompted mode when auto is requested without native structured output", async () => {
    const result = await generateObject({
      model: createLanguageModel({
        capabilities: {
          streaming: true,
          tools: true,
          structuredOutput: false,
          jsonMode: false,
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
          expect(input.structuredOutput).toBeUndefined();
          expect(input.messages.at(-1)).toMatchObject({
            role: "user",
            parts: [{ type: "text", text: "Generate JSON\n\nReturn only valid JSON matching the requested schema." }]
          });
          return {
            messages: [createTextMessage("assistant", JSON.stringify({ title: "Soup" }))],
            text: JSON.stringify({ title: "Soup" })
          };
        }
      }),
      prompt: "Generate JSON",
      schema: z.object({
        title: z.string()
      })
    });

    expect(result.objectMode).toBe("prompted");
  });

  it("streams structured output with partial object events", async () => {
    let requestMode: string | undefined;
    const result = streamObject({
      model: createLanguageModel({
        async stream(input) {
          requestMode = input.structuredOutput?.mode;
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "text-delta", textDelta: "{\"title\":\"Soup\"" };
            yield { type: "text-delta", textDelta: ",\"servings\":2}" };
            yield { type: "finish", finishReason: "stop" };
          })();
        }
      }),
      prompt: "Generate recipe JSON",
      schema: z.object({
        title: z.string(),
        servings: z.number()
      }),
      mode: "native"
    });

    const partials: Array<Partial<{ title: string; servings: number }>> = [];
    let completedObject: { title: string; servings: number } | undefined;

    for await (const event of result.eventStream) {
      if (event.type === "object-partial") {
        partials.push(event.partialObject);
      }

      if (event.type === "object-complete") {
        completedObject = event.object;
      }
    }

    const final = await result.collect();

    expect(requestMode).toBe("native");
    expect(partials).toContainEqual({ title: "Soup" });
    expect(completedObject).toEqual({ title: "Soup", servings: 2 });
    expect(final.object).toEqual({ title: "Soup", servings: 2 });
  });

  it("streams structured output in prompted mode when native is unavailable", async () => {
    let firstMessageText = "";
    const result = streamObject({
      model: createLanguageModel({
        capabilities: {
          streaming: true,
          tools: true,
          structuredOutput: false,
          jsonMode: false,
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
        async stream(input) {
          firstMessageText = input.messages[0]?.parts[0]?.type === "text" ? input.messages[0].parts[0].text : "";
          expect(input.structuredOutput).toBeUndefined();
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "text-delta", textDelta: "{\"title\":\"Soup\"}" };
            yield { type: "finish", finishReason: "stop" };
          })();
        }
      }),
      prompt: "Generate recipe JSON",
      schema: z.object({
        title: z.string()
      })
    });

    const final = await result.collect();

    expect(firstMessageText).toBe("Generate recipe JSON\n\nReturn only valid JSON matching the requested schema.");
    expect(final.objectMode).toBe("prompted");
    expect(final.object).toEqual({ title: "Soup" });
  });

  it("rejects invalid structured output", async () => {
    await expect(
      generateObject({
        model: createLanguageModel({
          async generate() {
            return {
              messages: [createTextMessage("assistant", "{\"title\": 1}")],
              text: "{\"title\": 1}"
            };
          }
        }),
        prompt: "Generate JSON",
        schema: z.object({
          title: z.string()
        })
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("streams text deltas", async () => {
    const result = streamText({
      model: createLanguageModel(),
      prompt: "Stream"
    });

    expect(await result.collect()).toMatchObject({ text: "hello world" });
  });

  it("streams plain text through textStream", async () => {
    const result = streamText({
      model: createLanguageModel(),
      prompt: "Stream"
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["hello", " world"]);
  });

  it("converts streamText into a text Response", async () => {
    const result = streamText({
      model: createLanguageModel(),
      prompt: "Stream"
    });

    const response = toTextStreamResponse(result);

    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("hello world");
  });

  it("serializes arbitrary async iterables as SSE", async () => {
    const response = toSSEResponse(
      (async function* () {
        yield { hello: "world" };
      })(),
      { event: "message" }
    );
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: message");
    expect(body).toContain('data: {"hello":"world"}');
  });

  it("maps model messages into UI messages", () => {
    const message = toUIMessage(createTextMessage("assistant", "hello"), "assistant-1");

    expect(message).toEqual({
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }]
    });
  });

  it("maps stream events into UI message chunks", async () => {
    const result = streamText({
      model: createLanguageModel(),
      prompt: "Stream"
    });

    const chunks = [];
    for await (const chunk of toUIMessageStream(result, "assistant-1")) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toMatchObject({
      type: "text-delta",
      messageId: "assistant-1",
      role: "assistant",
      textDelta: "hello"
    });
    expect(chunks.at(-1)).toMatchObject({
      type: "finish",
      messageId: "assistant-1"
    });
  });

  it("converts UI message chunks into an SSE response", async () => {
    const response = toUIMessageStreamResponse(
      (async function* () {
        yield {
          type: "text-delta" as const,
          messageId: "assistant-1",
          role: "assistant" as const,
          textDelta: "hello"
        };
      })()
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("event: text-delta");
  });

  it("streams tools across multiple steps", async () => {
    let call = 0;
    const result = streamText({
      model: createLanguageModel({
        async stream() {
          call += 1;
          if (call === 1) {
            return (async function* (): AsyncGenerator<StreamEvent> {
              yield { type: "tool-call", toolCall: { id: "1", name: "weather", input: { city: "Madrid" } } };
              yield { type: "finish", finishReason: "tool-calls" };
            })();
          }

          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "text-delta", textDelta: "Madrid is sunny." };
            yield { type: "finish", finishReason: "stop" };
          })();
        }
      }),
      prompt: "Weather?",
      maxSteps: 2,
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      }
    });

    const events: StreamEvent[] = [];
    for await (const event of result.eventStream) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "tool-call")).toBe(true);
    expect(events.some((event) => event.type === "tool-result")).toBe(true);
    expect((await result.collect()).text).toBe("Madrid is sunny.");
  });

  it("embeds values", async () => {
    const result = await embed({
      model: createEmbeddingModel(),
      value: "vectorize"
    });

    expect(result.values).toEqual(["vectorize"]);
    expect(result.embeddings[0]).toHaveLength(2);
  });

  it("embeds many values", async () => {
    const result = await embedMany({
      model: createEmbeddingModel({
        async embed(input) {
          return {
            embeddings: input.values.map((value, index) => [value.length, index])
          };
        }
      }),
      value: ["a", "bb"]
    });

    expect(result.embeddings).toEqual([
      [1, 0],
      [2, 1]
    ]);
  });

  it("propagates unsupported features", async () => {
    await expect(
      embed({
        model: createEmbeddingModel({
          async embed() {
            throw new UnsupportedFeatureError("No embeddings");
          }
        }),
        value: "x"
      })
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it("wraps language models with a cache middleware", async () => {
    let calls = 0;
    const cache = createInMemoryGenerateCache();
    const wrapped = wrapLanguageModel(
      createLanguageModel({
        async generate() {
          calls += 1;
          return { messages: [createTextMessage("assistant", "cached hello")], text: "cached hello" };
        }
      }),
      [createCachedGenerateMiddleware({ cache })]
    );

    const first = await generateText({ model: wrapped, prompt: "hello" });
    const second = await generateText({ model: wrapped, prompt: "hello" });

    expect(first.text).toBe("cached hello");
    expect(second.text).toBe("cached hello");
    expect(calls).toBe(1);
  });

  it("emits telemetry events through middleware", async () => {
    const events: string[] = [];
    const wrapped = wrapLanguageModel(createLanguageModel(), [
      createTelemetryMiddleware({
        onEvent(event) {
          events.push(event.type);
        }
      })
    ]);

    await generateText({
      model: wrapped,
      prompt: "hello"
    });

    expect(events).toEqual(["generate-start", "generate-finish"]);
  });

  it("emits tool execution telemetry during generateText", async () => {
    const events: any[] = [];
    let call = 0;
    const wrapped = wrapLanguageModel(
      createLanguageModel({
        async generate() {
          call += 1;
          if (call === 1) {
            return {
              messages: [
                {
                  role: "assistant",
                  parts: [{ type: "tool-call", toolCall: { id: "1", name: "weather", input: { city: "Madrid" } } }]
                }
              ]
            };
          }

          return { messages: [createTextMessage("assistant", "Madrid is sunny.")], text: "Madrid is sunny." };
        }
      }),
      [
        createTelemetryMiddleware({
          onEvent(event) {
            events.push(event);
          }
        })
      ]
    );

    const result = await generateText({
      model: wrapped,
      prompt: "Weather?",
      maxSteps: 2,
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      }
    });

    expect(result.text).toBe("Madrid is sunny.");
    expect(events.map((event) => event.type)).toEqual([
      "generate-start",
      "generate-finish",
      "tool-execution-start",
      "tool-execution-finish",
      "generate-start",
      "generate-finish"
    ]);
    expect(events[2]).toMatchObject({
      type: "tool-execution-start",
      step: 1,
      toolCall: { id: "1", name: "weather", input: { city: "Madrid" } }
    });
    expect(events[3]).toMatchObject({
      type: "tool-execution-finish",
      step: 1,
      toolResult: {
        toolCallId: "1",
        toolName: "weather",
        output: { city: "Madrid", forecast: "sunny" },
        isError: false
      }
    });
  });

  it("applies streaming middleware in order", async () => {
    const calls: string[] = [];
    const wrapped = wrapLanguageModel(createLanguageModel(), [
      {
        name: "first",
        async wrapStream(_context, next) {
          calls.push("first:before");
          const stream = await next();

          return (async function* () {
            for await (const event of stream) {
              yield event;
            }
            calls.push("first:after");
          })();
        }
      },
      {
        name: "second",
        async wrapStream(_context, next) {
          calls.push("second:before");
          const stream = await next();

          return (async function* () {
            for await (const event of stream) {
              yield event;
            }
            calls.push("second:after");
          })();
        }
      }
    ]);

    const stream = await wrapped.stream!({
      messages: [user("hello")]
    });

    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
    expect(calls).toEqual(["first:before", "second:before", "second:after", "first:after"]);
  });

  it("rejects when streaming middleware calls next multiple times", async () => {
    const wrapped = wrapLanguageModel(createLanguageModel(), [
      {
        async wrapStream(_context, next) {
          await next();
          return next();
        }
      }
    ]);

    await expect(
      wrapped.stream!({
        messages: [user("hello")]
      })
    ).rejects.toThrow("Language model middleware called next() multiple times.");
  });

  it("preserves streaming for middlewares that only wrap generate", async () => {
    const wrapped = wrapLanguageModel(createLanguageModel(), [
      {
        async wrapGenerate(context, next) {
          expect(context.model.provider).toBe("test");
          return next();
        }
      }
    ]);

    const result = streamText({
      model: wrapped,
      prompt: "Stream"
    });

    expect(await result.collect()).toMatchObject({ text: "hello world" });
  });

  it("emits stream telemetry events through middleware", async () => {
    const events: string[] = [];
    const wrapped = wrapLanguageModel(createLanguageModel(), [
      createTelemetryMiddleware({
        onEvent(event) {
          events.push(event.type);
        }
      })
    ]);

    const stream = await wrapped.stream!({
      messages: [user("hello")]
    });

    for await (const _event of stream) {
      // drain stream
    }

    expect(events).toEqual(["stream-start", "stream-finish"]);
  });

  it("includes finish metadata in stream telemetry", async () => {
    const events: any[] = [];
    const wrapped = wrapLanguageModel(
      createLanguageModel({
        async stream() {
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "text-delta", textDelta: "hello" };
            yield {
              type: "finish",
              finishReason: "stop",
              providerFinishReason: "completed",
              usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }
            };
          })();
        }
      }),
      [
        createTelemetryMiddleware({
          onEvent(event) {
            events.push(event);
          }
        })
      ]
    );

    const stream = await wrapped.stream!({
      messages: [user("hello")]
    });

    for await (const _event of stream) {
      // drain stream
    }

    expect(events.at(-1)).toMatchObject({
      type: "stream-finish",
      finishReason: "stop",
      providerFinishReason: "completed",
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }
    });
  });

  it("emits stream error telemetry when iteration fails", async () => {
    const events: string[] = [];
    const wrapped = wrapLanguageModel(
      createLanguageModel({
        async stream() {
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "text-delta", textDelta: "hello" };
            throw new Error("stream failed");
          })();
        }
      }),
      [
        createTelemetryMiddleware({
          onEvent(event) {
            events.push(event.type);
          }
        })
      ]
    );

    const stream = await wrapped.stream!({
      messages: [user("hello")]
    });

    await expect(
      (async () => {
        for await (const _event of stream) {
          // drain stream
        }
      })()
    ).rejects.toThrow("stream failed");

    expect(events).toEqual(["stream-start", "stream-error"]);
  });

  it("emits stream error telemetry when the provider stream setup fails", async () => {
    const events: string[] = [];
    const wrapped = wrapLanguageModel(
      createLanguageModel({
        async stream() {
          throw new Error("setup failed");
        }
      }),
      [
        createTelemetryMiddleware({
          onEvent(event) {
            events.push(event.type);
          }
        })
      ]
    );

    await expect(
      wrapped.stream!({
        messages: [user("hello")]
      })
    ).rejects.toThrow("setup failed");

    expect(events).toEqual(["stream-start", "stream-error"]);
  });

  it("keeps streamText working with wrapped streaming middleware and tools", async () => {
    const events: string[] = [];
    let call = 0;
    const wrapped = wrapLanguageModel(
      createLanguageModel({
        async stream() {
          call += 1;
          if (call === 1) {
            return (async function* (): AsyncGenerator<StreamEvent> {
              yield { type: "tool-call", toolCall: { id: "1", name: "weather", input: { city: "Madrid" } } };
              yield { type: "finish", finishReason: "tool-calls" };
            })();
          }

          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "text-delta", textDelta: "Madrid is sunny." };
            yield { type: "finish", finishReason: "stop" };
          })();
        }
      }),
      [
        createTelemetryMiddleware({
          onEvent(event) {
            events.push(event.type);
          }
        })
      ]
    );

    const result = streamText({
      model: wrapped,
      prompt: "Weather?",
      maxSteps: 2,
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      }
    });

    expect((await result.collect()).text).toBe("Madrid is sunny.");
    expect(events).toEqual([
      "stream-start",
      "stream-finish",
      "tool-execution-start",
      "tool-execution-finish",
      "stream-start",
      "stream-finish"
    ]);
  });

  it("emits tool execution error telemetry when a tool fails during streamText", async () => {
    const events: any[] = [];
    const wrapped = wrapLanguageModel(
      createLanguageModel({
        async stream() {
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "tool-call", toolCall: { id: "1", name: "weather", input: { city: "Madrid" } } };
            yield { type: "finish", finishReason: "tool-calls" };
          })();
        }
      }),
      [
        createTelemetryMiddleware({
          onEvent(event) {
            events.push(event);
          }
        })
      ]
    );

    const result = streamText({
      model: wrapped,
      prompt: "Weather?",
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: () => {
            throw new Error("weather offline");
          }
        })
      }
    });

    expect((await result.collect()).toolResults).toMatchObject([
      {
        toolCallId: "1",
        toolName: "weather",
        isError: true
      }
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "stream-start",
      "stream-finish",
      "tool-execution-start",
      "tool-execution-error"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "tool-execution-error",
      step: 1,
      toolCall: { id: "1", name: "weather", input: { city: "Madrid" } }
    });
  });

  it("persists cached generate results to the filesystem", async () => {
    let calls = 0;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-cache-"));
    const wrapped = wrapLanguageModel(
      createLanguageModel({
        async generate() {
          calls += 1;
          return { messages: [createTextMessage("assistant", "disk hello")], text: "disk hello" };
        }
      }),
      [createCachedGenerateMiddleware({ cache: createFileGenerateCache({ dir }) })]
    );

    const first = await generateText({ model: wrapped, prompt: "hello" });
    const second = await generateText({ model: wrapped, prompt: "hello" });

    expect(first.text).toBe("disk hello");
    expect(second.text).toBe("disk hello");
    expect(calls).toBe(1);
  });

  it("opens a circuit breaker after repeated failures", async () => {
    const states: string[] = [];
    const wrapped = wrapLanguageModel(
      createLanguageModel({
        async generate() {
          throw new Error("upstream failed");
        }
      }),
      [
        createCircuitBreakerMiddleware({
          failureThreshold: 2,
          cooldownMs: 60_000,
          onStateChange(state) {
            states.push(state.status);
          }
        })
      ]
    );

    await expect(generateText({ model: wrapped, prompt: "hello" })).rejects.toThrow("upstream failed");
    await expect(generateText({ model: wrapped, prompt: "hello" })).rejects.toThrow("upstream failed");
    await expect(generateText({ model: wrapped, prompt: "hello" })).rejects.toThrow("Circuit breaker open");
    expect(states).toContain("open");
  });

  it("parses and returns UI messages through fetch helpers", async () => {
    const messages = [toUIMessage(user("Hello"), "msg_1")];
    const request = new Request("https://example.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messages)
    });

    const parsed = await parseUIMessageRequest(request);
    expect(parsed).toEqual(messages);

    const jsonResponse = createUIMessageJsonResponse(messages);
    expect(await jsonResponse.json()).toEqual(messages);

    const linesResponse = createUIMessageLinesResponse(messages);
    expect(await linesResponse.text()).toContain("\"id\":\"msg_1\"");
  });

  it("creates a searchable model catalog", () => {
    const catalog = createModelCatalog([
      { provider: "openai", modelId: "gpt-4o-mini", aliases: ["fast-openai"], costPer1kTokens: 0.6 }
    ]);

    expect(catalog.find("openai", "gpt-4o-mini")?.costPer1kTokens).toBe(0.6);
    expect(catalog.find("openai", "fast-openai")?.modelId).toBe("gpt-4o-mini");
    expect(catalog.list()).toHaveLength(1);
  });
});
