import { expect, it, vi } from "vitest";
import { createModelCatalog } from "@zhivex-ai/core";
import { createMockLanguageModel } from "../../core/src/testing.js";
import { createGateway } from "../src/index.js";
const catalog = createModelCatalog(["gemini", "bedrock"].map(provider => ({ provider, modelId: "fixture", inputCostPer1kTokens: 1, outputCostPer1kTokens: 2 })), { snapshotVersion: "test", pricing: { version: "1", unit: "per_1k_tokens", currency: "USD" } });
const usage = { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, totalTokens: 110 };
const request = { primary: { provider: "gemini" as const, modelId: "fixture" }, messages: [{ role: "user" as const, content: "hello" }], maxTokens: 10 };
const model = () => createMockLanguageModel({ responses: [{ text: "done", messages: [{ role: "assistant", parts: [{ type: "text", text: "done" }] }], usage }], streamEvents: [[{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop", usage }]] });
it.each([false, true])("values reported attempt usage and preflight estimates (stream=%s)", async streaming => {
  const gateway = createGateway({ adapters: { gemini: { name: "fixture", languageModel: model } }, modelCatalog: catalog, costAccounting: {} });
  const output = streaming ? await gateway.streamText(request).collect() : await gateway.generate(request);
  expect(output.attempts[0]!.cost).toMatchObject({ status: "known", currency: "USD", catalogVersion: "test" });
  expect(output.attempts[0]!.cost?.amount).toBeCloseTo(.12);
  expect(output.routeDecision.estimatedCosts?.[0]).toMatchObject({ status: "estimated", currency: "USD" });
});
it("does not declare failed fallback attempts free", async () => {
  const failed = model(); failed.generate = vi.fn(async () => { throw new Error("503 fixture"); });
  const gateway = createGateway({ adapters: { gemini: { name: "fail", languageModel: () => failed }, bedrock: { name: "ok", languageModel: model } }, modelCatalog: catalog, costAccounting: {}, maxRetries: 0, scoreTarget: ({ isPrimary }) => isPrimary ? 1 : 0 });
  const output = await gateway.generate({ ...request, fallbacks: [{ provider: "bedrock", modelId: "fixture" }] });
  expect(output.attempts[0]!.cost).toMatchObject({ status: "unknown", amount: null });
  expect(output.attempts[1]!.cost?.amount).toBeCloseTo(.12);
});
it("rejects an unknown quote before effects while preserving the legacy budget", async () => {
  const generate = vi.fn(); const fixture = model(); fixture.generate = generate;
  const gateway = createGateway({ adapters: { gemini: { name: "test", languageModel: () => fixture } }, modelCatalog: catalog, costAccounting: { unknownCostPolicy: "reject" } });
  await expect(gateway.generate({ ...request, maxTokens: undefined })).rejects.toThrow("detailed request cost is unknown");
  await expect(gateway.generate({ ...request, maxCostPer1kTokens: 0 })).rejects.toThrow("cost is unknown under");
  expect(generate).not.toHaveBeenCalled();
});
it("does not retry a successful response with invalid accounting counters", async () => {
  const fixture = model(); fixture.generate = vi.fn(async () => ({ messages: [], text: "done", usage: { inputTokens: -1 } }));
  const gateway = createGateway({ adapters: { gemini: { name: "test", languageModel: () => fixture } }, modelCatalog: catalog, costAccounting: {} });
  const output = await gateway.generate(request);
  expect(output.attempts[0]!.cost?.unknownReasons).toContain("invalid-reported-usage");
  expect(fixture.generate).toHaveBeenCalledTimes(1);
});
