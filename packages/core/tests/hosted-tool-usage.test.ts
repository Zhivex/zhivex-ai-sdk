import { expect, it } from "vitest";
import { createMockLanguageModel, streamText, type HostedToolUsage } from "../src/index.js";
it("preserves independent metering snapshots through collection without adding them to tokens", async () => {
  const record: HostedToolUsage = { type: "hosted-tool-usage", audience: "internal", provider: "fixture", route: "responses", tool: "web_search", attemptId: "attempt-1", unit: "call", quantity: 2, source: "fixture", aggregation: "snapshot", completeness: "complete", terminal: true };
  const model = createMockLanguageModel({ responses: [] });
  model.stream = async () => (async function* () {
    yield { type: "provider-data" as const, provider: "fixture", data: { ...record, completeness: "partial" as const, terminal: false } };
    yield { type: "provider-data" as const, provider: "fixture", data: record };
    yield { type: "finish" as const, finishReason: "stop" as const, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  })();
  const result = await streamText({ model, prompt: "fixture" }).collect();
  expect(result.messages.at(-1)?.parts.filter(p => p.type === "provider-data")).toHaveLength(2);
  expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
});

it("keeps internal metering off UI messages and streams while preserving public sources", async () => {
  const { toUIMessage, toUIMessageStream } = await import("../src/ui.js");
  const internal = { type: "hosted-tool-usage", audience: "internal", quantity: 2 };
  const source = { type: "response.annotations", annotations: [] };
  const message = { role: "assistant" as const, parts: [
    { type: "provider-data" as const, provider: "qwen", data: internal },
    { type: "provider-data" as const, provider: "qwen", data: source }
  ] };
  expect(toUIMessage(message).parts).toEqual([message.parts[1]]);
  const events = (async function* () { for (const part of message.parts) yield part; })();
  const chunks = []; for await (const chunk of toUIMessageStream(events)) chunks.push(chunk);
  expect(chunks.filter(chunk => chunk.type === "provider-data")).toEqual([expect.objectContaining({ data: source })]);
  expect(JSON.stringify(chunks)).not.toContain("hosted-tool-usage");
});
