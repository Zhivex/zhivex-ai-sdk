import { describe, expect, it } from "vitest";
import { createTextMessage, type HostedToolUsage, type StreamEvent } from "@zhivex-ai/core";
import { streamSSE } from "@zhivex-ai/core/provider";
import { createQwen, qwenWebSearchTool, type QwenRegion } from "../src/index.js";

const enabled = process.env.QWEN_SEARCH_INTEGRATION === "1";
const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
if (enabled && !apiKey) throw new Error("QWEN_SEARCH_INTEGRATION requires QWEN_API_KEY or DASHSCOPE_API_KEY.");

const readEvents = async (response: Response) => {
  const events: any[] = [];
  for await (const event of streamSSE(response)) {
    if (event.data !== "[DONE]") events.push(JSON.parse(event.data));
  }
  return events;
};
const searchSnapshots = (events: StreamEvent[]) => events
  .filter(event => event.type === "provider-data" && (event.data as any)?.type === "web_search_call")
  .map(event => (event as any).data);
const terminalUsage = (events: StreamEvent[]) => events
  .filter(event => event.type === "provider-data" && (event.data as any)?.type === "hosted-tool-usage" && (event.data as any).terminal)
  .map(event => (event as any).data as HostedToolUsage);

describe.skipIf(!enabled)("Qwen Responses hosted search sources live", () => {
  it("preserves upstream sources and metering, including a terminal-only replay", async () => {
    let captured = Promise.resolve<any[]>([]);
    let sentMaxOutputTokens: unknown;
    const modelId = process.env.QWEN_SEARCH_MODEL ?? "qwen3.8-flash";
    const model = createQwen({ apiKey, baseURL: process.env.QWEN_BASE_URL,
      workspaceId: process.env.QWEN_WORKSPACE_ID, region: process.env.QWEN_REGION as QwenRegion | undefined,
      fetch: async (url, init) => {
        sentMaxOutputTokens = JSON.parse(String(init?.body)).max_output_tokens;
        const response = await globalThis.fetch(url, init);
        if (!response.ok) throw new Error(`Qwen hosted search returned HTTP ${response.status}.`);
        captured = readEvents(response.clone());
        return response;
      }
    })(modelId);
    const input = {
      messages: [createTextMessage("user", "Search the web for the official Qwen website and return its URL.")],
      tools: { search: qwenWebSearchTool() }, toolChoice: "required" as const,
      maxTokens: 4096, reasoning: { effort: "none" as const },
      providerOptions: { apiMode: "responses" as const }, timeoutMs: 90_000, maxRetries: 0
    };
    const events: StreamEvent[] = [];
    for await (const event of await model.stream(input)) events.push(event);
    const upstream = await captured;
    const terminal = upstream.find(event => event.type === "response.completed")?.response;
    expect(terminal?.status).toBe("completed");
    const searches = terminal.output.filter((item: any) => item.type === "web_search_call");
    expect(searches.length).toBeGreaterThan(0);
    const sourceCount = searches.reduce((sum: number, item: any) => sum + (item.action?.sources?.length ?? 0), 0);
    expect(sourceCount).toBeGreaterThan(0);
    for (const search of searches) expect(searchSnapshots(events)).toContainEqual(search);
    const snapshots = searchSnapshots(events).map(item => JSON.stringify(item));
    expect(new Set(snapshots).size).toBe(snapshots.length);
    const count = terminal.usage?.x_tools?.web_search?.count;
    expect(Number.isSafeInteger(count) && count > 0).toBe(true);
    expect(terminalUsage(events)).toMatchObject([{ quantity: count, completeness: "complete", aggregation: "snapshot" }]);
    const finish = events.find(event => event.type === "finish");
    expect(finish).toMatchObject({ type: "finish", finishReason: "stop" });
    expect(sentMaxOutputTokens).toBe(4096);
    expect(finish?.usage?.outputTokens).toBeLessThanOrEqual(4096);

    // Reuse the actual upstream payload offline to exercise the missing-event
    // path deterministically, regardless of this server's intermediate events.
    const replayModel = createQwen({ apiKey: "offline-fixture", fetch: async () => new Response(
      `data: ${JSON.stringify({ type: "response.completed", response: terminal })}\n\n`,
      { headers: { "content-type": "text/event-stream" } }
    ) })(modelId);
    const replay: StreamEvent[] = [];
    for await (const event of await replayModel.stream(input)) replay.push(event);
    expect(searchSnapshots(replay)).toEqual(searches);
    expect(terminalUsage(replay)).toMatchObject([{ quantity: count, completeness: "complete" }]);
    console.info(JSON.stringify({ model: modelId, upstreamSearchCalls: searches.length, sourceCount,
      terminalSearchCount: count, maxOutputTokens: sentMaxOutputTokens, terminalOnlyReplay: "passed" }));
  }, 100_000);
});
