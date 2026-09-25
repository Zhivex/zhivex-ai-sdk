import assert from "node:assert/strict";
import { createModelCatalog, recommendAuxiliaryModel } from "@zhivex-ai/sdk";
import { defaultModelCatalog, listDefaultModelCatalogFragments } from "@zhivex-ai/sdk/catalog";
import * as coreMcp from "@zhivex-ai/core/mcp-http";
import * as sdkMcp from "@zhivex-ai/sdk/mcp-http";

assert.deepEqual(Object.keys(sdkMcp).sort(), Object.keys(coreMcp).sort());
assert.equal(typeof sdkMcp.createMcpHttpClient, "function");
const evidence = { source: "https://example.com/model", sourceType: "primary", verifiedAt: "2026-09-24" };
const entry = {
  provider: "fixture", modelId: "summary", contextWindowTokens: 1000, contextWindowType: "combined",
  maxOutputTokens: 100, inputCostPer1kTokens: 1, outputCostPer1kTokens: 2,
  compaction: { status: "candidate" },
  evidence: Object.fromEntries(["contextWindowTokens", "contextWindowType", "maxOutputTokens", "inputCostPer1kTokens", "outputCostPer1kTokens"].map(key => [key, evidence]))
};
const catalog = createModelCatalog([entry], {
  snapshotVersion: "fixture-v1", pricing: { version: "v1", currency: "USD", unit: "per_1k_tokens" }
});
const options = {
  catalog, routes: [{ provider: "fixture", modelId: "summary", available: true, credentialsAvailable: true }],
  inputTokens: 900, outputTokens: 100, now: "2026-09-24", maxEvidenceAgeMs: 86400000
};
assert.equal(recommendAuxiliaryModel(options).selected?.modelId, "summary");
assert.equal(recommendAuxiliaryModel({ ...options, inputTokens: 901 }).selected, undefined);
assert.equal(recommendAuxiliaryModel({ ...options, explicitRoute: { provider: "fixture", modelId: "missing" } }).selected, undefined);
assert.ok(defaultModelCatalog.list().length > 0);
assert.ok(listDefaultModelCatalogFragments().length > 0);
const requests = [];
const client = sdkMcp.createMcpHttpClient({
  url: "https://fixture.example/mcp",
  fetch: async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request.method);
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { resources: {}, tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : request.method === "resources/list"
        ? { resources: [{ name: "policy", uri: "fixture://policy" }] }
        : { contents: [{ uri: "fixture://policy", text: "untrusted content" }] };
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  }
});
assert.equal((await client.listResources()).resources[0].uri, "fixture://policy");
assert.equal((await client.readResource({ uri: "fixture://policy" })).contents[0].text, "untrusted content");
assert.deepEqual(requests, ["initialize", "notifications/initialized", "resources/list", "resources/read"]);
client.close();
console.log("Packed catalog contract, recommendation, managed inventory and MCP resource transport passed.");
