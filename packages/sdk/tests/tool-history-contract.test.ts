import { expect, it, vi } from "vitest";
import { createCachedGenerateMiddleware, createInMemoryGenerateCache, createMockLanguageModel, wrapLanguageModel, type ModelCapabilities, type ModelGenerateInput } from "../src/index.js";

it("preserves the history format through SDK middleware and isolates cached results", async () => {
  const capabilities: Partial<ModelCapabilities> = { toolHistory: "json" };
  const base = createMockLanguageModel({ capabilities });
  const generate = vi.fn(async (input: ModelGenerateInput) => ({ text: input.toolResultFormat ?? "raw", messages: [] }));
  const model = wrapLanguageModel({ ...base, generate }, [createCachedGenerateMiddleware({ cache: createInMemoryGenerateCache() })]);
  const input: ModelGenerateInput = { messages: [{ role: "user", parts: [{ type: "text", text: "Continue" }] }] };
  expect((await model.generate(input)).text).toBe("raw");
  expect((await model.generate({ ...input, toolResultFormat: "envelope" })).text).toBe("envelope");
  expect((await model.generate({ ...input, toolResultFormat: "envelope" })).text).toBe("envelope");
  expect(generate).toHaveBeenCalledTimes(2);
  expect(model.capabilities.toolHistory).toBe("json");
});
