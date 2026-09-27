import type { HostedToolUsage } from "@zhivex-ai/core/provider";

export const createGeminiSearchUsage = (modelId: string, attemptId: string) => {
  let quantity: number | undefined;
  let responseId: string | undefined;
  const modern = /^gemini-3(?:[.-]|$)/.test(modelId);
  const legacy = /^gemini-(?:2(?:\.\d+)?|1(?:\.\d+)?)(?:-|$)/.test(modelId);
  return (response?: any): HostedToolUsage => {
    if (typeof response?.responseId === "string" && response.responseId.length <= 1024) responseId = response.responseId;
    const candidate = response?.candidates?.[0];
    const queries = candidate?.groundingMetadata?.webSearchQueries;
    const valid = Array.isArray(queries) && queries.length <= 1024 && queries.every(q => typeof q === "string" && q.length <= 16384);
    if (valid && (modern || legacy)) {
      const unique = new Set<string>(queries.filter(q => q.trim().length > 0));
      quantity = modern ? unique.size : unique.size > 0 ? 1 : undefined;
    } else if (queries !== undefined) quantity = undefined;
    const terminal = !!candidate?.finishReason;
    return { type: "hosted-tool-usage", audience: "internal", provider: "gemini", route: "generate-content",
      tool: "google_search", attemptId, unit: modern ? "query" : legacy ? "grounded-prompt" : "unknown",
      source: "groundingMetadata.webSearchQueries", aggregation: "snapshot",
      completeness: quantity === undefined ? "unknown" : terminal && valid ? "complete" : "partial",
      ...(quantity !== undefined ? { quantity } : {}), ...(responseId ? { responseId } : {}), terminal };
  };
};
