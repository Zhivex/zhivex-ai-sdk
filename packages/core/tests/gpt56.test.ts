import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createTextMessage, defaultModelCatalog, estimateTokenCost, generateText, getAgentCapabilities, tool, user } from "../src/index.js";
import type { LanguageModel, ModelGenerateInput, StreamEvent } from "../src/index.js";

const createLanguageModel = (overrides: Partial<LanguageModel> = {}): LanguageModel => ({
  provider: "test",
  modelId: "gpt-5.6-test",
  capabilities: {
    streaming: true,
    tools: true,
    structuredOutput: true,
    jsonMode: true,
    toolChoice: true,
    parallelToolCalls: true,
    vision: true,
    files: true,
    audioInput: false,
    audioOutput: false,
    embeddings: false,
    explicitPromptCaching: true,
    reasoning: true,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    reasoningModes: ["standard", "pro"],
    reasoningContexts: ["auto", "current_turn", "all_turns"],
    webSearch: true,
    agentCapabilities: {
      supportTier: "tier-a",
      toolChoiceNone: true,
      approvalRequests: true,
      hostedWebSearch: true,
      hostedFileSearch: true,
      remoteMcp: true,
      computerUse: true,
      codeExecution: true,
      programmaticToolCalling: true,
      multiAgent: true,
      toolsets: true
    }
  },
  async generate() {
    return { messages: [createTextMessage("assistant", "done")], text: "done" };
  },
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "finish", finishReason: "stop" };
    })();
  },
  ...overrides
});

describe("GPT-5.6 shared contracts", () => {
  it("passes max effort, reasoning mode, and persisted reasoning context through core", async () => {
    let captured: ModelGenerateInput | undefined;
    const model = createLanguageModel({
      async generate(input) {
        captured = input;
        return { messages: [createTextMessage("assistant", "reasoned")], text: "reasoned" };
      }
    });

    await generateText({
      model,
      prompt: "Review this carefully",
      reasoning: {
        effort: "max",
        mode: "pro",
        context: "all_turns"
      }
    });

    expect(captured?.reasoning).toEqual({
      effort: "max",
      mode: "pro",
      context: "all_turns"
    });
  });

  it("accepts Responses-only reasoning controls without an effort", async () => {
    const seen: ModelGenerateInput["reasoning"][] = [];
    const model = createLanguageModel({
      async generate(input) {
        seen.push(input.reasoning);
        return { messages: [createTextMessage("assistant", "done")], text: "done" };
      }
    });

    await generateText({ model, prompt: "Continue", reasoning: { context: "current_turn" } });
    await generateText({ model, prompt: "Review", reasoning: { mode: "standard" } });

    expect(seen).toEqual([{ context: "current_turn" }, { mode: "standard" }]);
  });

  it("rejects GPT-5.6-only reasoning controls on models that do not advertise them", async () => {
    const model = createLanguageModel({
      capabilities: {
        ...createLanguageModel().capabilities,
        reasoningEfforts: undefined,
        reasoningModes: undefined,
        reasoningContexts: undefined
      }
    });

    await expect(generateText({ model, prompt: "Think", reasoning: { effort: "max" } })).rejects.toThrow(
      'does not support reasoning effort "max"'
    );
    await expect(generateText({ model, prompt: "Think", reasoning: { mode: "pro" } })).rejects.toThrow(
      'does not support reasoning mode "pro"'
    );
    await expect(
      generateText({ model, prompt: "Think", reasoning: { context: "all_turns" } })
    ).rejects.toThrow('does not support reasoning context "all_turns"');
  });

  it("preserves provider metadata on cacheable content parts", async () => {
    let capturedMessages: ModelGenerateInput["messages"] | undefined;
    const model = createLanguageModel({
      async generate(input) {
        capturedMessages = structuredClone(input.messages);
        return { messages: [createTextMessage("assistant", "done")], text: "done" };
      }
    });
    const messages = [
      user([
        {
          type: "text",
          text: "Reusable instructions",
          providerMetadata: { openai: { prompt_cache_breakpoint: { mode: "explicit" } } }
        },
        {
          type: "image",
          image: "https://example.com/reference.png",
          providerMetadata: { openai: { detail: "original" } }
        },
        {
          type: "file",
          data: "file_123",
          mediaType: "application/pdf",
          providerMetadata: { openai: { prompt_cache_breakpoint: { mode: "explicit" } } }
        }
      ])
    ];

    await generateText({ model, messages });

    expect(capturedMessages).toEqual(messages);
  });

  it("copies tool-call provider metadata to successful local tool results", async () => {
    let call = 0;
    let continuationMessages: ModelGenerateInput["messages"] | undefined;
    const caller = { type: "program", caller_id: "call_program_123" };
    const model = createLanguageModel({
      async generate(input) {
        call += 1;
        if (call === 1) {
          return {
            messages: [
              {
                role: "assistant",
                parts: [
                  {
                    type: "tool-call",
                    toolCall: {
                      id: "call_inventory_123",
                      name: "inventory",
                      input: { sku: "sku_123" },
                      providerMetadata: { openai: { caller } }
                    }
                  }
                ]
              }
            ],
            finishReason: "tool-calls"
          };
        }

        continuationMessages = structuredClone(input.messages);
        return { messages: [createTextMessage("assistant", "done")], text: "done" };
      }
    });

    const result = await generateText({
      model,
      prompt: "Check inventory",
      maxSteps: 2,
      tools: {
        inventory: tool({
          name: "inventory",
          schema: z.object({ sku: z.string() }),
          execute: ({ sku }) => ({ sku, available: 42 })
        })
      }
    });

    expect(result.toolResults[0]?.providerMetadata).toEqual({ openai: { caller } });
    expect(continuationMessages?.at(-1)).toMatchObject({
      role: "tool",
      parts: [
        {
          type: "tool-result",
          toolResult: {
            providerMetadata: { openai: { caller } }
          }
        }
      ]
    });
  });

  it("normalizes new agent capabilities and exposes explicit prompt caching", () => {
    const model = createLanguageModel();

    expect(model.capabilities.explicitPromptCaching).toBe(true);
    expect(getAgentCapabilities(model)).toMatchObject({
      programmaticToolCalling: true,
      multiAgent: true
    });
  });

  it("catalogs Sol, Terra, and Luna with the GPT-5.6 alias", () => {
    const sol = defaultModelCatalog.find("openai", "gpt-5.6");
    expect(defaultModelCatalog.find("openai", "gpt-5.5")?.costPer1kTokens).toBe(0.005);
    expect(defaultModelCatalog.find("openai", "gpt-4o-mini")?.costPer1kTokens).toBe(0.0006);
    expect(sol).toMatchObject({
      modelId: "gpt-5.6-sol",
      aliases: ["gpt-5.6"],
      inputCostPer1kTokens: 0.005,
      cachedInputCostPer1kTokens: 0.0005,
      cacheWriteCostPer1kTokens: 0.00625,
      outputCostPer1kTokens: 0.03,
      costPer1kTokens: 0.005,
      longContextPricing: {
        inputTokenThreshold: 272_000,
        inputMultiplier: 2,
        outputMultiplier: 1.5
      },
      recommendedFor: expect.arrayContaining(["chat", "reasoning", "tools", "vision"])
    });
    expect(defaultModelCatalog.find("openai", "gpt-5.6-terra")).toMatchObject({
      inputCostPer1kTokens: 0.0025,
      cachedInputCostPer1kTokens: 0.00025,
      cacheWriteCostPer1kTokens: 0.003125,
      outputCostPer1kTokens: 0.015,
      costPer1kTokens: 0.0025,
      recommendedFor: expect.arrayContaining(["chat", "reasoning", "tools", "vision"])
    });
    expect(defaultModelCatalog.find("openai", "gpt-5.6-luna")).toMatchObject({
      inputCostPer1kTokens: 0.001,
      cachedInputCostPer1kTokens: 0.0001,
      cacheWriteCostPer1kTokens: 0.00125,
      outputCostPer1kTokens: 0.006,
      costPer1kTokens: 0.001,
      recommendedFor: expect.arrayContaining(["chat", "reasoning", "speed", "tools", "vision"])
    });

    const estimate = estimateTokenCost(
      {
        inputTokens: 1000,
        cachedInputTokens: 200,
        cacheWriteTokens: 300,
        outputTokens: 500,
        reasoningTokens: 250,
        totalTokens: 1500
      },
      sol
    );
    expect(estimate.inputCost).toBeCloseTo(0.004475);
    expect(estimate.outputCost).toBeCloseTo(0.015);
    expect(estimate.totalCost).toBeCloseTo(0.019475);

    const thresholdEstimate = estimateTokenCost(
      { inputTokens: 272_000, outputTokens: 1_000 },
      sol
    );
    expect(thresholdEstimate.inputCost).toBeCloseTo(1.36);
    expect(thresholdEstimate.outputCost).toBeCloseTo(0.03);

    const longContextEstimate = estimateTokenCost(
      {
        inputTokens: 272_001,
        cachedInputTokens: 100_000,
        cacheWriteTokens: 100_000,
        outputTokens: 1_000
      },
      sol
    );
    expect(longContextEstimate.inputCost).toBeCloseTo(2.07001);
    expect(longContextEstimate.outputCost).toBeCloseTo(0.045);
  });
});
