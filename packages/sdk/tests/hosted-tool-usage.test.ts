import { expect, it } from "vitest";
import { createMockLanguageModel, generateText, type HostedToolUsage, type HostedToolSupport } from "../src/index.js";
it("exposes the hosted metering contract through the SDK without pricing or token aggregation", async () => {
  const support: HostedToolSupport = { route: "responses", tool: "web_search", limit: "unverified", metering: "provider-counter" };
  const data: HostedToolUsage = { type: "hosted-tool-usage", audience: "internal", provider: "fixture", route: support.route, tool: support.tool, attemptId: "one", unit: "call", source: "fixture", aggregation: "snapshot", completeness: "unknown", terminal: true };
  const model = createMockLanguageModel({ responses: [{ text: "", messages: [{ role: "assistant", parts: [{ type: "provider-data", provider: "fixture", data }] }], finishReason: "stop" }] });
  const result = await generateText({ model, prompt: "fixture" });
  expect(result.messages.at(-1)?.parts).toContainEqual({ type: "provider-data", provider: "fixture", data });
  expect(data.quantity).toBeUndefined();
});
