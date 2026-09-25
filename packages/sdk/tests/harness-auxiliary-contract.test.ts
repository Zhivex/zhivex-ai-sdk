import { describe, expect, it, vi } from "vitest";
import {
  Agent,
  createAgentBudgetCoordinator,
  createInMemoryAgentRunStore,
  createMcpToolSet,
  createMockLanguageModel,
  createModelCatalog,
  createTextMessage,
  recommendAuxiliaryModel,
  type AgentCompactionAttempt,
  type AgentCompactionAuxiliaryRoute,
  type McpClient,
  type ModelCatalogDatumEvidence
} from "../src/index.js";
import { createMcpHttpClient } from "../src/mcp-http.js";

const messages = [createTextMessage("user", "Earlier context. ".repeat(100)), createTextMessage("assistant", "Earlier answer."), createTextMessage("user", "Continue.")];
const mainModel = () => createMockLanguageModel({ responses: [{ text: "done", messages: [createTextMessage("assistant", "done")], finishReason: "stop", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }] });
const route: AgentCompactionAuxiliaryRoute = { provider: "fixture", modelId: "summarizer", fingerprint: "summarizer-prompt-v1", reservation: { inputTokens: 40, outputTokens: 5, totalTokens: 45 } };

describe("Harness-facing SDK public contracts", () => {
  it("preserves independent shared budget ceilings through the public SDK", async () => {
    const coordinator = createAgentBudgetCoordinator({
      store: createInMemoryAgentRunStore(), budgetId: "sdk-remainder",
      limits: { inputTokens: 32, outputTokens: 8, totalTokens: 39 }
    });
    await coordinator.reserve("child", { inputTokens: 32, outputTokens: 8, totalTokens: 39 });
    await expect(coordinator.reserve("competitor", { inputTokens: 0, outputTokens: 0, totalTokens: 1 })).rejects.toThrow("exceeds totalTokens");
    await coordinator.settle("child", { inputTokens: 8, outputTokens: 2, totalTokens: 11 });
    await coordinator.reserve("released", { inputTokens: 24, outputTokens: 6, totalTokens: 28 });
  });

  it("preserves optional catalog metadata and makes recommendation an explicit operation", () => {
    const evidence: ModelCatalogDatumEvidence = { source: "https://fixture.example/models/summarizer", sourceType: "primary", verifiedAt: "2026-09-24" };
    const catalog = createModelCatalog([
      { provider: "legacy", modelId: "main" },
      { provider: "fixture", modelId: "summarizer", maxInputTokens: 1000, maxOutputTokens: 100, evidence: { maxInputTokens: evidence, maxOutputTokens: evidence }, compaction: { status: "candidate" } }
    ]);
    const before = catalog.list();
    const recommendation = recommendAuxiliaryModel({ catalog, routes: [{ provider: "fixture", modelId: "summarizer", available: true, credentialsAvailable: true }], inputTokens: 500, outputTokens: 50, now: "2026-09-24T12:00:00Z", maxEvidenceAgeMs: 86400000 });
    expect(recommendation.selected?.modelId).toBe("summarizer");
    expect(recommendation.selected?.estimatedCost).toBeUndefined();
    expect(catalog.list()).toEqual(before);
    expect(catalog.find("legacy", "main")).toEqual({ provider: "legacy", modelId: "main" });
  });

  it("accepts existing two-method MCP clients and retains host approval defaults", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "done" }] }));
    const legacyClient: McpClient = { listTools: async () => [{ name: "lookup", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }], callTool };
    const tools = await createMcpToolSet(legacyClient);
    expect(legacyClient.listResources).toBeUndefined();
    expect(tools.lookup?.requiresApproval).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
    expect(await tools.lookup!.execute({})).toMatchObject({ content: [{ type: "text", text: "done" }] });
  });

  it("uses the optional HTTP subpath without network activity before invocation", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = request.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { resources: {} }, serverInfo: { name: "fixture", version: "1" } }
        : { resources: [{ uri: "fixture://report", name: "report" }] };
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    });
    const client: McpClient = createMcpHttpClient({ url: "https://fixture.example/mcp", fetch: fetcher as typeof fetch });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await client.listResources!()).toEqual({ resources: [{ uri: "fixture://report", name: "report" }] });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps default runs free of auxiliary receipts and preserves legacy local compactors", async () => {
    const plain = await new Agent({ model: mainModel() }).run({ prompt: "Hello" });
    expect(plain.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    expect(plain.state.compactionAttempts ?? []).toEqual([]);
    const compacted = await new Agent({ model: mainModel(), compaction: { maxMessages: 2, keepRecentMessages: 1, compactor: () => ({ summary: "Earlier context." }) } }).run({ messages });
    expect(compacted.state.compactions).toHaveLength(1);
    expect(compacted.state.compactionAttempts ?? []).toEqual([]);
    expect(compacted.usage).toEqual(plain.usage);
  });

  it("persists public auxiliary receipts separately and adds confirmed tokens exactly once", async () => {
    const store = createInMemoryAgentRunStore();
    const agent = new Agent({ model: mainModel(), store, compaction: { maxMessages: 2, keepRecentMessages: 1, auxiliary: route, compactor: () => ({ summary: "Earlier context.", usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 } }) } });
    const result = await agent.run({ runId: "sdk-auxiliary", messages });
    expect(result.usage).toEqual({ inputTokens: 140, outputTokens: 25, totalTokens: 165 });
    const receipt: AgentCompactionAttempt = result.state.compactionAttempts![0]!;
    expect(receipt).toMatchObject({ status: "confirmed", route, usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 } });
    const persisted = await store.load("sdk-auxiliary");
    expect(persisted?.compactionAttempts).toEqual([receipt]);
    expect(persisted?.usage).toEqual(result.usage);
    expect(persisted?.compactions).toHaveLength(1);
  });
});
