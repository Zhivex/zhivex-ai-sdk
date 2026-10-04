import { expect, it, vi } from "vitest";
import { createModelCatalog, ProviderToolCallError } from "@zhivex-ai/core";
import { createMockLanguageModel } from "../../core/src/testing.js";
import { createGatewayExecutor } from "../src/execution.js";

const target = { provider: "openai" as const, modelId: "fixture" };
const catalog = createModelCatalog([{ ...target, inputCostPer1kTokens: 1, outputCostPer1kTokens: 1 }], { snapshotVersion: "test", pricing: { version: "1", currency: "USD", unit: "per_1k_tokens" } });
const usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0 };

it.each(["generate", "stream-open", "stream-first"] as const)("settles confirmed failures but keeps uncertain consumption reserved (%s)", async mode => {
  for (const complete of [false, true]) {
    const settle = vi.fn(); const release = vi.fn();
    const executor = createGatewayExecutor({ adapters: {}, modelCatalog: catalog, budget: { currency: "USD", reserveAmount: .5, store: { reserve: async () => ({ settle, cancel: vi.fn() }) } }, admission: { acquire: async () => ({ release }) } });
    const error = new ProviderToolCallError({ provider: "openai", reason: "response_failed", diagnosticCode: "OPENAI_PTC_REQUEST_FAILED", effectsPossible: true, confirmedUsage: usage, usageComplete: complete, providerRequestCount: 1 });
    const model = createMockLanguageModel(); model.generate = async () => { throw error; };
    model.stream = async () => {
      if (mode === "stream-open") throw error;
      return (async function* () { throw error; })();
    };
    const input = { messages: [] };
    const run = async () => {
      if (mode === "generate") await executor.generate(model, target, input, "tenant");
      else for await (const _ of await executor.stream(model, target, input, "tenant")) { /* consume */ }
    };
    await expect(run()).rejects.toBe(error); await executor.flush();
    expect(settle).toHaveBeenCalledTimes(1); expect(settle).toHaveBeenCalledWith(complete ? .02 : null);
    expect(release).toHaveBeenCalledWith(complete ? 20 : undefined);
  }
});
