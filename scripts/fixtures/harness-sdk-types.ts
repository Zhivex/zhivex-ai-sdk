import {
  createModelCatalog,
  recommendAuxiliaryModel,
  type AgentCompactionAuxiliaryRoute,
  type ModelCatalogEntry,
  type McpClient
} from "@zhivex-ai/sdk";
import { createMcpHttpClient, createMcpOAuthProvider } from "@zhivex-ai/sdk/mcp-http";
import type { AgentCompactionAttempt } from "@zhivex-ai/agents";

const legacy: McpClient = {
  async listTools() { return []; },
  async callTool() { return { content: [] }; }
};
const entry: ModelCatalogEntry = { provider: "fixture", modelId: "legacy" };
const route: AgentCompactionAuxiliaryRoute = {
  provider: "fixture", modelId: "summary", fingerprint: "v1",
  reservation: { inputTokens: 40, outputTokens: 5, totalTokens: 45 }
};
const receipt: AgentCompactionAttempt = {
  id: "fixture", beforeStep: 1, sourceDigest: "sha256:fixture", createdAt: 0,
  route, status: "unknown"
};
recommendAuxiliaryModel({
  catalog: createModelCatalog([entry]), routes: [], inputTokens: 100, outputTokens: 10,
  now: "2026-09-24", maxEvidenceAgeMs: 86400000
});
void [legacy, receipt, createMcpHttpClient, createMcpOAuthProvider];
