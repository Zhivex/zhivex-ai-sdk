import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createMockLanguageModel } from "../src/agent-evaluation.js";
import { createModelCatalog } from "../src/catalog.js";
import {
  Agent,
  Output,
  clearRegisteredModelProviders,
  createAgentRunLedger,
  createGroqCompatible,
  createMistralCompatible,
  createModelResolver,
  dynamicTool,
  generateObject,
  generateText,
  hasToolCall,
  jsonSchema,
  openaiCompatible,
  registerModelProvider,
  resolveLanguageModel,
  stepCountIs,
  streamObject,
  streamText,
  tool,
  ModelResolutionError,
  type GenerateResult,
  type LanguageModel,
  type ModelGenerateInput,
  type ToolCall
} from "../src/index.js";
import * as beta from "../src/beta-entry.js";
import { resetSamplingWarnings } from "../src/sampling.js";

const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };
const textResult = (text: string): GenerateResult => ({
  text,
  finishReason: "stop",
  usage,
  messages: [{ role: "assistant", parts: [{ type: "text", text }] }]
});
const toolResult = (call: ToolCall): GenerateResult => ({
  finishReason: "tool-calls",
  usage,
  messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: call }] }]
});
const readCall = (id = "call-1", input: ToolCall["input"] = {}): ToolCall => ({ id, name: "read", input });

const mock = (responses: GenerateResult[], streams = responses) => createMockLanguageModel({
  responses,
  streamEvents: streams.map((response) => [
    ...((response.messages ?? []).flatMap((message) => message.parts.flatMap((part) => {
      if (part.type === "tool-call") return [{ type: "tool-call" as const, toolCall: part.toolCall }];
      if (part.type === "text") return [{ type: "text-delta" as const, textDelta: part.text }];
      return [];
    }))),
    { type: "finish" as const, finishReason: response.finishReason ?? "stop", usage: response.usage }
  ])
});

const watch = (model: LanguageModel): { model: LanguageModel; requests: ModelGenerateInput[] } => {
  const requests: ModelGenerateInput[] = [];
  const generate = model.generate.bind(model);
  const stream = model.stream?.bind(model);
  model.generate = async (input) => {
    requests.push(input);
    return generate(input);
  };
  if (stream) {
    model.stream = async (input) => {
      requests.push(input);
      return stream(input);
    };
  }
  return { model, requests };
};

afterEach(() => {
  clearRegisteredModelProviders();
  resetSamplingWarnings();
  vi.restoreAllMocks();
});

describe("model strings and OpenAI-compatible providers", () => {
  it("keeps a model object call on the previous one-step shape", async () => {
    const result = await generateText({ model: mock([textResult("done")]), prompt: "Hello" });
    expect(result.text).toBe("done");
    expect(result.steps).toHaveLength(1);
    expect("output" in result).toBe(false);
    expect(result.approvalRequests ?? []).toEqual([]);
  });

  it("resolves a registered provider/model string and does not fall back", async () => {
    let generated = 0;
    registerModelProvider({
      name: "demo",
      languageModel: (modelId) => mock([textResult(`demo/${modelId}`)])
    });
    const resolved = resolveLanguageModel("demo/echo");
    expect(resolved.provider).toBe("mock");
    const result = await generateText({ model: "demo/echo", prompt: "Hello" });
    expect(result.text).toBe("demo/echo");
    registerModelProvider({
      name: "other",
      languageModel: () => {
        generated += 1;
        return mock([textResult("nope")]);
      }
    });
    await expect(generateText({ model: "missing/model", prompt: "Hello" })).rejects.toMatchObject({
      name: "ModelResolutionError",
      code: "unknown_provider"
    });
    expect(generated).toBe(0);
  });

  it("lets an explicit modelResolver win over the process registry", async () => {
    const catalog = createModelCatalog([{
      provider: "openai",
      modelId: "gpt-test",
      inputCostPer1kTokens: 0.1,
      outputCostPer1kTokens: 0.2
    }], { snapshotVersion: "parity-1" });
    const resolver = createModelResolver({
      adapters: {
        openai: {
          name: "openai",
          languageModel: (modelId) => mock([textResult(`resolver/${modelId}`)])
        }
      },
      catalog
    });
    registerModelProvider({
      name: "openai",
      languageModel: () => mock([textResult("registry")])
    });
    const result = await generateText({
      model: "openai/gpt-test",
      modelResolver: resolver,
      prompt: "Hello"
    });
    expect(result.text).toBe("resolver/gpt-test");
    await expect(generateText({
      model: "openai/not-in-catalog",
      modelResolver: resolver,
      prompt: "Hello"
    })).rejects.toMatchObject({ code: "unknown_model" });
  });

  it("keeps the beta resolver export as the same function", () => {
    expect(beta.createModelResolver).toBe(createModelResolver);
    expect(beta.ModelResolutionError).toBe(ModelResolutionError);
  });

  it("accepts a string model in generateObject and streamObject", async () => {
    registerModelProvider({
      name: "demo",
      languageModel: () => mock([textResult('{"ok":true}')])
    });
    const object = await generateObject({
      model: "demo/echo",
      schema: z.object({ ok: z.boolean() }),
      prompt: "Return json",
      mode: "prompted"
    });
    expect(object.object).toEqual({ ok: true });

    clearRegisteredModelProviders();
    registerModelProvider({
      name: "demo",
      languageModel: () => mock([textResult('{"ok":true}')])
    });
    const streamed = await streamObject({
      model: "demo/echo",
      schema: z.object({ ok: z.boolean() }),
      prompt: "Return json",
      mode: "prompted"
    }).collect();
    expect(streamed.object).toEqual({ ok: true });
  });

  it("fails closed when an OpenAI-compatible provider has no api key", () => {
    const fetch = vi.fn();
    expect(() => openaiCompatible({
      name: "hosted",
      baseURL: "https://example.test/v1",
      apiKey: "  ",
      fetch
    })).toThrow(ModelResolutionError);
    try {
      openaiCompatible({ name: "hosted", baseURL: "https://example.test/v1", apiKey: "", fetch });
    } catch (error) {
      expect(error).toMatchObject({ code: "missing_credentials" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls a registered compatible endpoint and maps sampling fields", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
      });
    });
    const provider = openaiCompatible({
      name: "hosted",
      baseURL: "https://example.test/v1",
      apiKey: "test-key",
      fetch,
      register: true
    });
    const direct = await generateText({
      model: provider.languageModel("chat"),
      prompt: "Hello",
      topP: 0.2,
      seed: 7,
      stopSequences: ["END"]
    });
    expect(direct.text).toBe("hi");
    const viaString = await generateText({
      model: "hosted/chat",
      prompt: "Hello",
      topP: 0.2,
      seed: 7,
      stopSequences: ["END"]
    });
    expect(viaString.text).toBe("hi");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://example.test/v1/chat/completions");
    expect(bodies[0]).toMatchObject({ top_p: 0.2, seed: 7, stop: ["END"], model: "chat" });
    const headers = new Headers((fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
  });

  it("uses the documented Mistral and Groq base URLs", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    });
    await generateText({
      model: createMistralCompatible({ apiKey: "mistral-key", fetch }).languageModel("mistral-small"),
      prompt: "Hello"
    });
    await generateText({
      model: createGroqCompatible({ apiKey: "groq-key", fetch }).languageModel("llama-3.3-70b-versatile"),
      prompt: "Hello"
    });
    expect(urls).toEqual([
      "https://api.mistral.ai/v1/chat/completions",
      "https://api.groq.com/openai/v1/chat/completions"
    ]);
  });
});

describe("loop controls, output, and tools", () => {
  const readTool = (
    execute: (input: { q?: string }, context?: { context?: unknown }) => string = () => "ok"
  ) => tool({
    name: "read",
    schema: z.object({ q: z.string().optional() }),
    execute
  });

  it.each([false, true])("stops with stepCountIs and a custom predicate (stream=%s)", async (streaming) => {
    const responses = [toolResult(readCall("a")), toolResult(readCall("b")), textResult("done")];
    const { model, requests } = watch(mock(responses));
    const run = streaming
      ? streamText({
        model,
        prompt: "go",
        stopWhen: stepCountIs(2),
        tools: { read: readTool() }
      }).collect()
      : generateText({
        model,
        prompt: "go",
        stopWhen: [stepCountIs(5), hasToolCall("read")],
        tools: { read: readTool() }
      });
    const result = await run;
    if (streaming) {
      expect(result.steps).toHaveLength(2);
      expect(requests).toHaveLength(2);
    } else {
      expect(result.steps).toHaveLength(1);
      expect(result.toolResults).toHaveLength(1);
    }
  });

  it("overrides the model, tools, system, and messages for one step", async () => {
    const first = watch(mock([toolResult(readCall())]));
    const second = watch(mock([textResult("second")]));
    const result = await generateText({
      model: first.model,
      prompt: "go",
      maxSteps: 2,
      tools: {
        read: readTool(),
        hidden: tool({ name: "hidden", schema: z.object({}), execute: () => "hidden" })
      },
      prepareStep: ({ stepNumber }) => stepNumber === 0
        ? { system: "first-system", activeTools: ["read"] }
        : {
          model: second.model,
          tools: { read: readTool() },
          messages: [{ role: "user", parts: [{ type: "text", text: "replaced" }] }],
          system: "second-system"
        }
    });
    expect(result.text).toBe("second");
    expect(first.requests[0]?.messages[0]).toMatchObject({ role: "system", parts: [{ text: "first-system" }] });
    expect(Object.keys(first.requests[0]?.tools ?? {})).toEqual(["read"]);
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]?.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(second.requests[0]?.messages[1]).toMatchObject({ parts: [{ text: "replaced" }] });
  });

  it("restricts activeTools on the request", async () => {
    const { model, requests } = watch(mock([textResult("done")]));
    await generateText({
      model,
      prompt: "go",
      activeTools: ["read"],
      tools: {
        read: readTool(),
        hidden: tool({ name: "hidden", schema: z.object({}), execute: () => "no" })
      }
    });
    expect(Object.keys(requests[0]?.tools ?? {})).toEqual(["read"]);
  });

  it("returns Output.object and Output.text without adding output to old calls", async () => {
    const withTools = await generateText({
      model: mock([toolResult(readCall()), textResult('{"ok":true}')]),
      prompt: "go",
      maxSteps: 2,
      output: Output.object({ schema: z.object({ ok: z.boolean() }) }),
      tools: { read: readTool() }
    });
    expect(withTools.toolResults).toHaveLength(1);
    expect(withTools.output).toEqual({ ok: true });

    const text = await generateText({
      model: mock([textResult("plain")]),
      prompt: "go",
      output: Output.text()
    });
    expect(text.output).toBe("plain");

    const legacy = await generateText({ model: mock([textResult("plain")]), prompt: "go" });
    expect(legacy.output).toBeUndefined();
  });

  it("accepts raw JSON Schema and dynamic tools", async () => {
    const schema = jsonSchema<{ id: string }>({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    });
    let dynamicInput: unknown;
    const result = await generateText({
      model: mock([
        toolResult({ id: "json", name: "lookup", input: { id: "a" } }),
        toolResult({ id: "dyn", name: "dyn", input: { extra: true } }),
        textResult("done")
      ]),
      prompt: "go",
      maxSteps: 3,
      tools: {
        lookup: tool({
          name: "lookup",
          inputSchema: schema,
          execute: (input) => input.id
        }),
        dyn: dynamicTool({
          name: "dyn",
          inputSchema: jsonSchema({ type: "object", additionalProperties: true }),
          execute: (input) => {
            dynamicInput = input;
            return "dynamic";
          }
        })
      }
    });
    expect(result.toolResults.map((entry) => entry.output)).toEqual(["a", "dynamic"]);
    expect(dynamicInput).toEqual({ extra: true });
    expect(result.toolResults[1]?.isError).toBe(false);

    await expect(generateText({
      model: mock([toolResult({ id: "bad", name: "lookup", input: { id: 1 } })]),
      prompt: "go",
      tools: {
        lookup: tool({
          name: "lookup",
          inputSchema: schema,
          execute: () => {
            throw new Error("must not execute");
          }
        })
      }
    })).rejects.toThrow(/Invalid input for tool "lookup"/);
  });

  it("passes toolsContext to execute", async () => {
    let seen: unknown;
    await generateText({
      model: mock([toolResult(readCall()), textResult("done")]),
      prompt: "go",
      maxSteps: 2,
      toolsContext: { tenant: "acme" },
      tools: {
        read: tool({
          name: "read",
          schema: z.object({}),
          execute: (_input, context) => {
            seen = context;
            return "ok";
          }
        })
      }
    });
    expect(seen).toMatchObject({ context: { tenant: "acme" } });
  });

  it("warns and continues when the model does not support sampling options", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await generateText({
      model: mock([textResult("done")]),
      prompt: "go",
      topP: 0.4,
      seed: 3,
      stopSequences: ["END"]
    });
    expect(result.text).toBe("done");
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain('does not support topP');
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("seed");
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("stopSequences");
  });

  it("still gates tool execution on approval when loop options are set", async () => {
    let executions = 0;
    const result = await generateText({
      model: mock([toolResult(readCall()), textResult("done")]),
      prompt: "go",
      stopWhen: stepCountIs(4),
      activeTools: ["read"],
      prepareStep: () => ({ activeTools: ["read"] }),
      tools: {
        read: tool({
          name: "read",
          schema: z.object({}),
          requiresApproval: true,
          approvalMode: "interrupt",
          execute: () => {
            executions += 1;
            return "ok";
          }
        }),
        hidden: tool({ name: "hidden", schema: z.object({}), execute: () => "no" })
      }
    });
    expect(executions).toBe(0);
    expect(result.approvalRequests).toHaveLength(1);
    expect(result.toolResults).toHaveLength(0);

    const agent = new Agent({
      model: mock([toolResult(readCall()), textResult("done")]),
      maxSteps: 4,
      tools: {
        read: tool({
          name: "read",
          schema: z.object({}),
          requiresApproval: true,
          approvalMode: "interrupt",
          execute: () => {
            executions += 1;
            return "ok";
          }
        })
      }
    });
    const waiting = await agent.run({
      prompt: "go",
      stopWhen: stepCountIs(4),
      activeTools: ["read"],
      prepareStep: () => ({ activeTools: ["read"] }),
      topP: 0.5
    });
    expect(waiting.status).toBe("waiting_approval");
    expect(executions).toBe(0);
    const ledger = createAgentRunLedger(waiting.state);
    expect(ledger.type).toBe("agent_run_ledger");
    expect(ledger.status).toBe("waiting_approval");
  });
});
