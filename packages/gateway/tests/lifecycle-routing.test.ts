import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createModelCatalog } from "@zhivex-ai/core/catalog";
import { createMockLanguageModel } from "@zhivex-ai/core/testing";
import { createGateway, type GatewayConfig } from "../src/index.js";

const retired = { provider: "gemini" as const, modelId: "old-pro" };
const active = { provider: "gemini" as const, modelId: "plain" };
const catalog = createModelCatalog([
  { ...retired, lifecycle: { retiredAt: "2000-01-01", source: "https://example.com/lifecycle" } },
  { ...active, lifecycle: { deprecatedAt: "2000-01-01", retiredAt: "2999-01-01", source: "https://example.com/lifecycle" } }
]);
const adapter = () => ({ name: "fixture", languageModel: vi.fn((modelId: string) => createMockLanguageModel({
  modelId, capabilities: { streaming: true, tools: true, structuredOutput: true, jsonMode: true },
  responses: [{ text: '{"value":"ok"}', messages: [{ role: "assistant", parts: [{ type: "text", text: '{"value":"ok"}' }] }], finishReason: "stop" }],
  streamEvents: [[{ type: "text-delta", textDelta: '{"value":"ok"}' }, { type: "finish", finishReason: "stop" }]]
})) });
const request = { primary: retired, fallbacks: [active], messages: [{ role: "user" as const, content: "hello" }] };

for (const operation of ["generate", "streamText", "generateObject", "streamObject", "runAgent", "streamAgent"] as const) {
  it(`filters lifecycle before constructing models for ${operation}`, async () => {
    const fixture = adapter();
    const gateway = createGateway({ adapters: { gemini: fixture }, modelCatalog: catalog });
    let result;
    if (operation === "generate") result = await gateway.generate(request);
    else if (operation === "streamText") result = await gateway.streamText(request).collect();
    else if (operation === "generateObject") result = await gateway.generateObject({ ...request, schema: z.object({ value: z.string() }) });
    else if (operation === "streamObject") result = await gateway.streamObject({ ...request, schema: z.object({ value: z.string() }) }).collect();
    else if (operation === "runAgent") result = await gateway.runAgent(request);
    else result = await gateway.streamAgent(request).collect();
    expect(result.modelUsed).toBe(active.modelId);
    expect(fixture.languageModel.mock.calls.map(call => call[0])).toEqual([active.modelId]);
    expect(result.attempts[0]?.reasonCode).toBe("model-lifecycle");
    expect(result.routeDecision.lifecycle).toEqual([
      { target: retired, status: "retired", effectiveAt: "2000-01-01", source: "https://example.com/lifecycle" },
      { target: active, status: "deprecated", effectiveAt: "2000-01-01", source: "https://example.com/lifecycle" }
    ]);
  });
}

it("allows retired IDs only through an explicitly configured private deployment", async () => {
  const fixture = adapter();
  const config: GatewayConfig = { adapters: { gemini: fixture }, modelCatalog: catalog,
    deployments: { private: { provider: "gemini", adapter: fixture, allowRetiredModels: true } } };
  const gateway = createGateway(config);
  await expect(gateway.generate({ ...request, fallbacks: [] })).rejects.toThrow("retired");
  expect(fixture.languageModel).not.toHaveBeenCalled();
  const result = await gateway.generate({ ...request, primary: { ...retired, deploymentId: "private" }, fallbacks: [] });
  expect(result.routeDecision.lifecycle?.[0]?.status).toBe("retired-override");
});

it("uses directional prices and a configurable penalty for unknown costs", async () => {
  const fixture = adapter();
  const modelCatalog = createModelCatalog([{ ...active, inputCostPer1kTokens: 0.1, outputCostPer1kTokens: 0.2 }]);
  const gateway = createGateway({ adapters: { gemini: fixture }, modelCatalog, routingPolicy: { mode: "evidence" } });
  expect((await gateway.generate(request)).modelUsed).toBe(active.modelId);
  const overridden = createGateway({ adapters: { gemini: fixture }, modelCatalog, routingPolicy: { mode: "evidence", unknownCostPenalty: 0 } });
  expect((await overridden.generate(request)).modelUsed).toBe(retired.modelId);
  const generate = vi.fn();
  const budgetGateway = createGateway({ adapters: { gemini: { name: "budget", languageModel: id => {
    const model = fixture.languageModel(id); model.generate = generate; return model;
  } } }, modelCatalog });
  await expect(budgetGateway.generate({ ...request, primary: active, fallbacks: [], maxCostPer1kTokens: 0.15 })).rejects.toThrow("unknown");
  await expect(budgetGateway.generate({ ...request, fallbacks: [], maxCostPer1kTokens: 0.15 })).rejects.toThrow("unknown");
  expect(generate).not.toHaveBeenCalled();
  const directionalBudget = createGateway({ adapters: { gemini: fixture }, modelCatalog, costBudgetRate: "conservative" });
  await expect(directionalBudget.generate({ ...request, primary: active, fallbacks: [], maxCostPer1kTokens: 0.15 })).rejects.toThrow("exceeds");
  expect((await directionalBudget.generate({ ...request, primary: active, fallbacks: [], maxCostPer1kTokens: 0.2 })).modelUsed).toBe(active.modelId);
});

it("selects explicit task quality without model-name boosts and validates policies", async () => {
  const fixture = adapter();
  const gateway = createGateway({ adapters: { gemini: fixture }, routingPolicy: { mode: "evidence", qualityProfiles: [
    { target: active, intent: "reasoning", score: 0.9, version: "eval-1" }
  ] } });
  expect((await gateway.generate({ ...request, routingMode: "quality", taskIntent: "reasoning" })).modelUsed).toBe(active.modelId);
  expect((await gateway.generate({ ...request, routingMode: "quality", taskIntent: "chat" })).modelUsed).toBe(retired.modelId);
  expect(() => createGateway({ adapters: {}, routingPolicy: { unknownCostPenalty: -1 } })).toThrow("unknownCostPenalty");
  expect(() => createGateway({ adapters: {}, routingPolicy: { mode: "evidence" }, scoreTarget: () => 1 })).toThrow("Choose routingPolicy");
});

it("bounds declared cache-write and long-context rates in conservative token budgets", async () => {
  const fixture = adapter();
  const modelCatalog = createModelCatalog([{ ...active,
    inputCostPer1kTokens: 0.1, outputCostPer1kTokens: 0.2,
    cacheWriteCostPer1kTokens: 0.3,
    longContextPricing: { inputTokenThreshold: 100, inputMultiplier: 2, outputMultiplier: 1.5 }
  }]);
  const gateway = createGateway({ adapters: { gemini: fixture }, modelCatalog, costBudgetRate: "conservative" });
  await expect(gateway.generate({ ...request, primary: active, fallbacks: [], maxCostPer1kTokens: 0.5 })).rejects.toThrow("exceeds");
  expect((await gateway.generate({ ...request, primary: active, fallbacks: [], maxCostPer1kTokens: 0.6 })).modelUsed).toBe(active.modelId);
});
