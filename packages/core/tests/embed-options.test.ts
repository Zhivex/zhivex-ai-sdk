import { expect, it, vi } from "vitest";
import { embedMany, createMockLanguageModel } from "../src/index.js";
it("forwards embedding options and preserves input order without mutation", async () => {
  const providerOptions = Object.freeze({ outputDimensionality: 256, autoTruncate: false });
  const embed = vi.fn(async () => ({ embeddings: [[1], [2]] }));
  const result = await embedMany({ model: { ...createMockLanguageModel(), embed }, value: ["first", "second"], providerOptions });
  expect(embed.mock.calls[0][0]).toMatchObject({ values: ["first", "second"], providerOptions });
  expect(result.embeddings).toEqual([[1], [2]]);
});
