import type { HostedToolUsage } from "@zhivex-ai/core/provider";

export const qwenSearchUsage = (attemptId: string, response?: any): HostedToolUsage => {
  const count = response?.usage?.x_tools?.web_search?.count;
  const valid = typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  return { type: "hosted-tool-usage", audience: "internal", provider: "qwen", route: "responses",
    tool: "web_search", attemptId, unit: "call", source: "usage.x_tools.web_search.count",
    aggregation: "snapshot", completeness: valid ? "complete" : "unknown",
    ...(valid ? { quantity: count } : {}),
    ...(typeof response?.id === "string" && response.id.length <= 1024 ? { responseId: response.id } : {}),
    terminal: response !== undefined };
};
