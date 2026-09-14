import { z } from "zod";
import { createAgent, createInMemoryAgentRunStore, runAgentGroup, tool, calculateModelCost, createModelCatalog, type TokenUsage, type ModelCostValuation } from "@zhivex-ai/sdk";
import { createGateway, createGatewayMetrics, createGatewayCircuitBreaker, type GatewayAdaptiveRoutingPolicy } from "@zhivex-ai/gateway";
import { createMockLanguageModel } from "@zhivex-ai/core/testing";

const contextSchema = z.object({ tenant: z.string() });
const definition = createAgent({ id: "configured", model: createMockLanguageModel(), contextSchema, store: createInMemoryAgentRunStore(), compaction: { maxMessages: 10, compactor: () => ({ summary: "context" }) }, tools: { read: tool({ name: "read", independent: true, schema: z.object({}), execute: () => "value" }) }, toolExecution: { parallel: true, independentOnly: true, maxConcurrency: 2 } });
const policy: GatewayAdaptiveRoutingPolicy = { version: "example-1", weights: { latency: 1, cost: 0, quality: 0, load: 1, errorRate: 1 }, latencyScaleMs: 100, costScale: 1, coldStart: "allow", unknownCost: "reject", missingQuality: "reject" };
const gateway = createGateway({ adapters: { gemini: { name: "example", languageModel: () => createMockLanguageModel() } }, metrics: createGatewayMetrics(), circuitBreaker: createGatewayCircuitBreaker(), adaptiveRouting: policy });
const context: z.infer<typeof contextSchema> = { tenant: "example" };
export const example = () => gateway.runAgent({ agent: definition, context, primary: { provider: "gemini", modelId: "example" }, messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }], compaction: false });
export const group = () => runAgentGroup([{ name: "one", agent: definition }], { prompt: "hello", maxConcurrency: 1, context });
const usage: TokenUsage = { inputTokens: 100, cachedInputTokens: 80, cacheWriteTokens: 10, outputTokens: 20, reasoningTokens: 5, totalTokens: 120, speed: "fast" };
const quote: ModelCostValuation = calculateModelCost({ catalog: createModelCatalog([]), provider: "example", modelId: "example", usage });
void quote;
// @ts-expect-error Independence requires an explicit boolean assertion.
tool({ name: "bad", independent: "yes", schema: z.object({}), execute: () => null });
