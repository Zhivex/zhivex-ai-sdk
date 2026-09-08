import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, createInMemoryAgentRunStore, tool } from "../src/index.js";
import { createOpenAI } from "@zhivex-ai/openai";

describe("SDK agent compaction through Responses", () => {
  it.each([false, true])("continues across two compacted contexts with native reasoning and tool history (stream=%s)", async (streaming) => {
    let calls = 0;
    const requests: any[] = [];
    const model = createOpenAI({ apiKey: "test", fetch: (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      const seen = new Set<string>();
      for (const item of request.input) {
        if (item.role === "assistant") {
          expect(item.content.every((part: any) => part.type === "output_text")).toBe(true);
        }
        if (item.type === "function_call") seen.add(item.call_id);
        if (item.type === "function_call_output") expect(seen.has(item.call_id)).toBe(true);
      }
      calls++;
      const output = calls < 4 ? [
        { type: "reasoning", id: `reason-${calls}`, summary: [], encrypted_content: `opaque-${calls}` },
        { type: "function_call", id: `item-${calls}`, call_id: `call-${calls}`, name: "inspect", arguments: "{}", status: "completed" }
      ] : [{ type: "message", id: "answer", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }];
      const response = { id: `resp-${calls}`, status: "completed", output, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } };
      if (!request.stream) return Response.json(response);
      const events = output.flatMap(item => [
        { type: "response.output_item.added", item },
        { type: "response.output_item.done", item }
      ]);
      return new Response([...events, { type: "response.completed", response }].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch })("gpt-5.6");
    const store = createInMemoryAgentRunStore();
    const agent = new Agent({ model, store, maxSteps: 4, providerOptions: { store: false },
      tools: { inspect: tool({ name: "inspect", schema: z.object({}), execute: () => ({ data: "x".repeat(500) }) }) },
      compaction: { maxMessages: 4, keepRecentMessages: 2, compactor: () => ({ summary: "Inspected." }) }
    });
    const input = { prompt: "Inspect three times." };
    const result = streaming ? await (async () => {
      const stream = agent.stream(input);
      await Array.fromAsync(stream.eventStream);
      return stream.collect();
    })() : await agent.run(input);
    expect(result.status).toBe("completed");
    expect(result.state.compactions).toHaveLength(2);
    expect(result.usage).toMatchObject({ inputTokens: 400, outputTokens: 40, totalTokens: 440 });
    expect((await store.load(result.state.runId))?.usage).toEqual(result.usage);
    expect(requests[3].input).toContainEqual({ type: "reasoning", id: "reason-3", summary: [], encrypted_content: "opaque-3" });
    expect(requests[3].input[0]).toMatchObject({ role: "assistant", content: [{ type: "output_text", text: "[Compacted prior conversation]\nInspected." }] });
  });
});
