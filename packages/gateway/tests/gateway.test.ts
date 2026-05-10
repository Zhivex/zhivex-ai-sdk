import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAgentHandoff, createInMemoryAgentRunStore, defaultModelCatalog, type ModelCapabilities, type ProviderAdapter } from "@zhivex-ai/core";
import { createGateway } from "../src/index.ts";

const createAdapter = (
  generateImpl: () => Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }>,
  capabilities: ModelCapabilities = {
    streaming: false,
    tools: false,
    structuredOutput: false,
    jsonMode: false,
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
): ProviderAdapter => ({
  name: "test",
  languageModel(modelId) {
    return {
      provider: "test",
      modelId,
      capabilities,
      async generate() {
        const result = await generateImpl();
        return {
          messages: [
            {
              role: "assistant",
              parts: [{ type: "text", text: result.text }]
            }
          ],
          text: result.text,
          usage: result.usage
        };
      }
    };
  }
});

const createStreamingAdapter = (
  streamImpl: () => Promise<AsyncIterable<{ type: "text-delta"; textDelta: string } | { type: "finish"; finishReason: "stop" }>>,
  capabilities: ModelCapabilities = {
    streaming: true,
    tools: false,
    structuredOutput: false,
    jsonMode: false,
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
): ProviderAdapter => ({
  name: "stream-test",
  languageModel(modelId) {
    return {
      provider: "stream-test",
      modelId,
      capabilities,
      async generate() {
        return { messages: [{ role: "assistant", parts: [{ type: "text", text: "unused" }] }], text: "unused" };
      },
      async stream() {
        return streamImpl();
      }
    };
  }
});

const createAgentCapableCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
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
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-b",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: true,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: false,
    toolsets: true
  },
  ...overrides
});

const createAgentAdapter = (
  generateImpl: () => Promise<{ text: string }>,
  capabilities: ModelCapabilities = createAgentCapableCapabilities()
): ProviderAdapter => ({
  name: "agent-test",
  languageModel(modelId) {
    return {
      provider: "agent-test",
      modelId,
      capabilities,
      async generate() {
        const result = await generateImpl();
        return {
          messages: [
            {
              role: "assistant",
              parts: [{ type: "text", text: result.text }]
            }
          ],
          text: result.text,
          finishReason: "stop"
        };
      },
      async stream() {
        const result = await generateImpl();
        return (async function* () {
          yield { type: "text-delta" as const, textDelta: result.text };
          yield { type: "finish" as const, finishReason: "stop" as const };
        })();
      }
    };
  }
});

describe("gateway", () => {
  it("orders targets and falls back after retryable failures", async () => {
    const failing = vi
      .fn()
      .mockRejectedValueOnce(new Error("429 rate limited"))
      .mockRejectedValueOnce(new Error("429 rate limited"))
      .mockRejectedValueOnce(new Error("429 rate limited"));
    const success = vi.fn().mockResolvedValue({ text: "hello from fallback" });

    const gateway = createGateway({
      adapters: {
        gemini: createAdapter(failing),
        bedrock: createAdapter(success)
      },
      maxRetries: 2,
      retryBackoffMs: 1
    });

    const result = await gateway.generate({
      primary: { provider: "gemini", modelId: "gemini-2.0-pro" },
      fallbacks: [{ provider: "bedrock", modelId: "anthropic.claude-3-5-sonnet" }],
      messages: [{ role: "user", content: "hello" }],
      routingMode: "quality",
      taskIntent: "reasoning"
    });

    expect(result.text).toBe("hello from fallback");
    expect(result.attempts).toHaveLength(4);
    expect(result.providerUsed).toBe("bedrock");
  });

  it("strips images for unsupported models", async () => {
    const inspect = vi.fn().mockImplementation(async () => ({ text: "ok" }));

    const gateway = createGateway({
      adapters: {
        bedrock: {
          name: "bedrock",
          languageModel(modelId) {
            return {
              provider: "bedrock",
              modelId,
              capabilities: {
                streaming: false,
                tools: false,
                structuredOutput: false,
                jsonMode: false,
                toolChoice: false,
                parallelToolCalls: false,
                vision: true,
                files: false,
                audioInput: false,
                audioOutput: false,
                embeddings: false,
                reasoning: false,
                webSearch: false
              },
              async generate(input) {
                inspect(input.messages);
                return {
                  messages: [{ role: "assistant", parts: [{ type: "text", text: "ok" }] }],
                  text: "ok"
                };
              }
            };
          }
        }
      }
    });

    await gateway.generate({
      primary: { provider: "bedrock", modelId: "anthropic.claude-v2" },
      messages: [
        {
          role: "user",
          content: "describe",
          images: [{ dataUrl: "data:image/png;base64,aGVsbG8=", mimeType: "image/png" }]
        }
      ]
    });

    const firstCall = inspect.mock.calls[0]?.[0] as Array<{ parts: Array<{ type: string }> }>;
    expect(firstCall[0]?.parts).toEqual([{ type: "text", text: "describe" }]);
  });

  it("estimates usage when a provider omits token counts", async () => {
    const gateway = createGateway({
      adapters: {
        ollama: createAdapter(async () => ({ text: "hello world" }))
      }
    });

    const result = await gateway.generate({
      primary: { provider: "ollama", modelId: "llama3.2" },
      messages: [{ role: "user", content: "hello" }]
    });

    expect(result.usage.estimated).toBe(true);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it("skips targets that do not satisfy required capabilities", async () => {
    const gateway = createGateway({
      adapters: {
        bedrock: createAdapter(async () => ({ text: "from bedrock" })),
        gemini: createAdapter(async () => ({ text: "from gemini" }), {
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
          reasoning: true,
          webSearch: false
        })
      }
    });

    const result = await gateway.generate({
      primary: { provider: "bedrock", modelId: "anthropic.claude-v2" },
      fallbacks: [{ provider: "gemini", modelId: "gemini-2.0-flash" }],
      messages: [{ role: "user", content: "hello" }],
      requiredCapabilities: {
        tools: true
      }
    });

    expect(result.providerUsed).toBe("gemini");
    expect(result.attempts[0]?.errorMessage).toContain("capabilities");
  });

  it("skips targets that exceed the configured cost budget", async () => {
    const gateway = createGateway({
      adapters: {
        openai: createAdapter(async () => ({ text: "expensive" })),
        ollama: createAdapter(async () => ({ text: "cheap" }))
      },
      providerCostsPer1kTokens: {
        openai: 2,
        ollama: 0
      }
    });

    const result = await gateway.generate({
      primary: { provider: "openai", modelId: "gpt-4o-mini" },
      fallbacks: [{ provider: "ollama", modelId: "llama3.2" }],
      messages: [{ role: "user", content: "hello" }],
      maxCostPer1kTokens: 0.5
    });

    expect(result.providerUsed).toBe("ollama");
    expect(result.attempts[0]?.errorMessage).toContain("cost");
  });

  it("emits attempt callbacks for observability", async () => {
    const attempts: string[] = [];
    const gateway = createGateway({
      adapters: {
        ollama: createAdapter(async () => ({ text: "hello world" }))
      },
      onAttempt(attempt) {
        attempts.push(`${attempt.provider}:${attempt.retry}:${attempt.targetRank}`);
      }
    });

    await gateway.generate({
      primary: { provider: "ollama", modelId: "llama3.2" },
      messages: [{ role: "user", content: "hello" }]
    });

    expect(attempts).toEqual(["ollama:0:0"]);
  });

  it("uses model catalog costs when no explicit provider cost is configured", async () => {
    const gateway = createGateway({
      adapters: {
        openai: createAdapter(async () => ({ text: "expensive" })),
        ollama: createAdapter(async () => ({ text: "cheap" }))
      },
      modelCatalog: defaultModelCatalog
    });

    const result = await gateway.generate({
      primary: { provider: "openai", modelId: "gpt-4o-mini" },
      fallbacks: [{ provider: "ollama", modelId: "llama3.2" }],
      messages: [{ role: "user", content: "hello" }],
      maxCostPer1kTokens: 0.2
    });

    expect(result.providerUsed).toBe("ollama");
  });

  it("falls back before streaming starts", async () => {
    const gateway = createGateway({
      adapters: {
        openai: createStreamingAdapter(async () => {
          throw new Error("429 rate limited");
        }),
        gemini: createStreamingAdapter(async () =>
          (async function* () {
            yield { type: "text-delta" as const, textDelta: "hello" };
            yield { type: "finish" as const, finishReason: "stop" as const };
          })()
        )
      },
      maxRetries: 0
    });

    const result = gateway.streamText({
      primary: { provider: "openai", modelId: "gpt-4o-mini" },
      fallbacks: [{ provider: "gemini", modelId: "gemini-2.0-flash" }],
      messages: [{ role: "user", content: "hello" }]
    });

    expect(await result.collect()).toMatchObject({
      text: "hello",
      providerUsed: "gemini"
    });
  });

  it("preserves the first stream event after probing a target", async () => {
    const gateway = createGateway({
      adapters: {
        openai: createStreamingAdapter(async () =>
          (async function* () {
            yield { type: "text-delta" as const, textDelta: "first" };
            yield { type: "text-delta" as const, textDelta: " second" };
            yield { type: "finish" as const, finishReason: "stop" as const };
          })()
        )
      }
    });

    const result = gateway.streamText({
      primary: { provider: "openai", modelId: "gpt-4o-mini" },
      messages: [{ role: "user", content: "hello" }]
    });

    const events = [];
    for await (const event of result.eventStream) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["text-delta", "text-delta", "finish", "finish"]);
    expect(events[0]).toEqual({ type: "text-delta", textDelta: "first" });
  });

  it("routes generateObject through the chosen provider", async () => {
    const gateway = createGateway({
      adapters: {
        gemini: {
          name: "gemini",
          languageModel(modelId) {
            return {
              provider: "gemini",
              modelId,
              capabilities: {
                streaming: true,
                tools: false,
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
              },
              async generate() {
                return {
                  messages: [{ role: "assistant", parts: [{ type: "text", text: "{\"answer\":\"ok\"}" }] }],
                  text: "{\"answer\":\"ok\"}"
                };
              }
            };
          }
        }
      }
    });

    const result = await gateway.generateObject({
      primary: { provider: "gemini", modelId: "gemini-2.0-flash" },
      messages: [{ role: "user", content: "hello" }],
      schema: z.object({
        answer: z.string()
      })
    });

    expect(result.object).toEqual({ answer: "ok" });
    expect(result.providerUsed).toBe("gemini");
  });

  it("skips object targets without compatible object output capabilities", async () => {
    const gateway = createGateway({
      adapters: {
        bedrock: createAdapter(async () => ({ text: "{\"answer\":\"bad\"}" })),
        gemini: createAdapter(async () => ({ text: "{\"answer\":\"ok\"}" }), {
          streaming: true,
          tools: false,
          structuredOutput: false,
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
        })
      }
    });

    const result = await gateway.generateObject({
      primary: { provider: "bedrock", modelId: "anthropic.claude-v2" },
      fallbacks: [{ provider: "gemini", modelId: "gemini-2.0-flash" }],
      messages: [{ role: "user", content: "hello" }],
      schema: z.object({
        answer: z.string()
      })
    });

    expect(result.providerUsed).toBe("gemini");
    expect(result.object).toEqual({ answer: "ok" });
    expect(result.attempts[0]?.errorMessage).toContain("object output");
  });

  it("routes streamObject with object metadata and preserved first event", async () => {
    const gateway = createGateway({
      adapters: {
        gemini: createStreamingAdapter(
          async () =>
            (async function* () {
              yield { type: "text-delta" as const, textDelta: "{\"answer\":" };
              yield { type: "text-delta" as const, textDelta: "\"ok\"}" };
              yield { type: "finish" as const, finishReason: "stop" as const };
            })(),
          {
            streaming: true,
            tools: false,
            structuredOutput: false,
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
        )
      }
    });

    const result = gateway.streamObject({
      primary: { provider: "gemini", modelId: "gemini-2.0-flash" },
      messages: [{ role: "user", content: "hello" }],
      schema: z.object({
        answer: z.string()
      })
    });

    const events = [];
    for await (const event of result.eventStream) {
      events.push(event);
    }

    const final = await result.collect();
    expect(events[0]).toMatchObject({ type: "text-delta", textDelta: "{\"answer\":" });
    expect(final.object).toEqual({ answer: "ok" });
    expect(final.providerUsed).toBe("gemini");
    expect(final.routeDecision.orderedTargets[0]).toEqual({
      provider: "gemini",
      modelId: "gemini-2.0-flash"
    });
  });

  it("routes agents according to required agent capabilities and saves state", async () => {
    const store = createInMemoryAgentRunStore();
    const gateway = createGateway({
      adapters: {
        bedrock: createAgentAdapter(async () => ({ text: "too limited" }), createAgentCapableCapabilities({
          agentCapabilities: {
            supportTier: "tier-c",
            toolChoiceNone: false,
            approvalRequests: false,
            hostedWebSearch: false,
            hostedFileSearch: false,
            remoteMcp: false,
            computerUse: false,
            codeExecution: false,
            toolsets: false
          }
        })),
        openai: createAgentAdapter(async () => ({ text: "agent from openai" }), createAgentCapableCapabilities({
          agentCapabilities: {
            supportTier: "tier-a",
            toolChoiceNone: true,
            approvalRequests: true,
            hostedWebSearch: true,
            hostedFileSearch: true,
            remoteMcp: true,
            computerUse: true,
            codeExecution: true,
            toolsets: true
          }
        }))
      }
    });

    const result = await gateway.runAgent({
      primary: { provider: "bedrock", modelId: "anthropic.claude-v2" },
      fallbacks: [{ provider: "openai", modelId: "gpt-5" }],
      prompt: "Use the best agent provider",
      requiredAgentCapabilities: {
        supportTier: "tier-a",
        approvalRequests: true
      },
      store
    });

    expect(result.providerUsed).toBe("openai");
    expect(result.outputText).toBe("agent from openai");
    expect(result.attempts[0]?.errorMessage).toContain("agent capabilities");
    expect(await store.load(result.state.runId)).toBeDefined();
  });

  it("streams routed agents and preserves route metadata on the final state", async () => {
    const gateway = createGateway({
      adapters: {
        gemini: createAgentAdapter(async () => ({ text: "streamed agent" }))
      }
    });

    const result = gateway.streamAgent({
      primary: { provider: "gemini", modelId: "gemini-2.0-flash" },
      prompt: "Stream this agent answer"
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    const final = await result.collect();
    expect(chunks.join("")).toBe("streamed agent");
    expect(final.providerUsed).toBe("gemini");
    expect(final.state.routeDecision.orderedTargets[0]).toEqual({
      provider: "gemini",
      modelId: "gemini-2.0-flash"
    });
  });

  it("passes handoffs through routed agents", async () => {
    const gateway = createGateway({
      adapters: {
        openai: createAgentAdapter(async () => ({ text: "handled handoff" }))
      }
    });

    const sourceGateway = createGateway({
      adapters: {
        openai: createAgentAdapter(async () => ({ text: "source output" }))
      }
    });

    const source = await sourceGateway.runAgent({
      primary: { provider: "openai", modelId: "gpt-4o-mini" },
      prompt: "Create source context"
    });

    const result = await gateway.runAgent({
      primary: { provider: "openai", modelId: "gpt-4o-mini" },
      handoff: createAgentHandoff({
        source
      })
    });

    expect(result.state.parentRunId).toBe(source.state.runId);
    expect(result.outputText).toContain("handled handoff");
  });
});
