import { expect, it } from "vitest";
import { estimateTokenCost } from "../src/agent-trace.js";
import { chatCompletionsUsage } from "../src/chat-completions-stream.js";
import { aggregateTokenUsage } from "../src/generate-text.js";

it("keeps a cache write lifetime split only when every write in the group is consistent", () => {
  expect(aggregateTokenUsage([
    { inputTokens: 10, cacheWriteTokens: 5, cacheWriteTokensDetails: { ttl30mTokens: 2, ttl12hTokens: 3 }, outputTokens: 1 },
    { inputTokens: 4, cacheWriteTokens: 2, cacheWriteTokensDetails: { ttl30mTokens: 2 }, outputTokens: 1 }
  ])).toMatchObject({
    inputTokens: 14,
    cacheWriteTokens: 7,
    cacheWriteTokensDetails: { ttl30mTokens: 4, ttl12hTokens: 3 },
    outputTokens: 2
  });

  const dropped = aggregateTokenUsage([
    { cacheWriteTokens: 5, cacheWriteTokensDetails: { ttl30mTokens: 2, ttl12hTokens: 3 } },
    { cacheWriteTokens: 4 }
  ]);
  expect(dropped?.cacheWriteTokens).toBe(9);
  expect(dropped).not.toHaveProperty("cacheWriteTokensDetails");
});

it("prices a matching lifetime split and clamps cache writes that exceed input", () => {
  const pricing = {
    inputCostPer1kTokens: 0.001,
    cachedInputCostPer1kTokens: 0.0001,
    cacheWriteCostPer1kTokens: 0.00125,
    outputCostPer1kTokens: 0
  };
  const estimate = estimateTokenCost({
    inputTokens: 12000,
    cachedInputTokens: 4000,
    cacheWriteTokens: 7000,
    cacheWriteTokensDetails: { ttl30mTokens: 3000, ttl12hTokens: 4000 },
    outputTokens: 0
  }, pricing);
  expect(estimate.inputCost).toBeCloseTo(0.01515);

  expect(estimateTokenCost(
    { inputTokens: 10, cachedInputTokens: 8, cacheWriteTokens: 5 },
    { inputCostPer1kTokens: 1 }
  ).inputCost).toBeCloseTo(0.01);
  expect(estimateTokenCost(
    { inputTokens: 10, cachedInputTokens: 8, cacheWriteTokens: 5, cacheWriteTokensDetails: { ttl30mTokens: 5 } },
    { inputCostPer1kTokens: 1 }
  ).inputCost).toBeCloseTo(0.01);
  expect(estimateTokenCost(
    {
      inputTokens: 100,
      cacheWriteTokens: 10,
      cacheWriteTokensDetails: { ttl30mTokens: 4, ttl12hTokens: 2 },
      outputTokens: 0
    },
    { inputCostPer1kTokens: 1, cacheWriteCostPer1kTokens: 3 }
  ).inputCost).toBeCloseTo(0.12);
});

it("maps Chat Completions cache write lifetimes and omits the split when the wire object has none", () => {
  expect(chatCompletionsUsage({
    prompt_tokens: 12000,
    completion_tokens: 10,
    total_tokens: 12010,
    prompt_tokens_details: {
      cached_tokens: 4000,
      cache_write_tokens: 7000,
      cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 }
    }
  })).toMatchObject({
    inputTokens: 12000,
    cachedInputTokens: 4000,
    cacheWriteTokens: 7000,
    cacheWriteTokensDetails: { ttl30mTokens: 3000, ttl12hTokens: 4000 }
  });

  const withoutSplit = chatCompletionsUsage({
    prompt_tokens: 4,
    completion_tokens: 3,
    total_tokens: 7,
    prompt_tokens_details: { cached_tokens: 1, cache_write_tokens: 1 }
  });
  expect(withoutSplit).not.toHaveProperty("cacheWriteTokensDetails");

  expect(chatCompletionsUsage({
    prompt_tokens: 8,
    completion_tokens: 1,
    total_tokens: 9,
    input_tokens_details: { cache_write_tokens_details: { ttl_12h_tokens: 2 } }
  })?.cacheWriteTokensDetails).toEqual({ ttl12hTokens: 2 });
});
