import { describe, expect, it, vi } from "vitest";
import { ProviderToolCallError, streamText, type StreamEvent } from "@zhivex-ai/core";
import { createBedrock } from "../src/index.js";
const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
const request = { messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "test" }] }], maxRetries: 2 };
const setup = (chunks: unknown[]) => {
  const fetcher = vi.fn().mockImplementation(async () => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"));
  const model = createBedrock({ runtime: "openai", apiKey: "test", baseURL: "https://bedrock.example.com", fetch: fetcher })("openai.gpt-oss-120b-1:0");
  return { model, fetcher };
};
const call = { type: "response.output_item.done", item: { type: "function_call", call_id: "call_a", name: "weather", arguments: "{}" } };
describe("Bedrock Responses terminal states", () => {
  it("rejects failed responses after partial text and retains terminal usage", async () => {
    const { model, fetcher } = setup([{ type: "response.output_text.delta", delta: "Partial" }, call, { type: "response.failed", response: { status: "failed", usage } }]);
    const events: StreamEvent[] = [];
    await expect((async () => { for await (const event of await model.stream!(request)) events.push(event); })()).rejects.toBeInstanceOf(ProviderToolCallError);
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "error", providerFinishReason: "failed", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
    expect(events.some(event => event.type === "tool-call")).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not resolve collect as a successful partial response", async () => {
    const { model, fetcher } = setup([{ type: "response.output_text.delta", delta: "Partial" }, { type: "response.failed", response: { status: "failed", usage } }]);
    await expect(streamText({ model, prompt: "test", maxRetries: 2 }).collect()).rejects.toMatchObject({
      name: "ProviderToolCallError", provider: "bedrock", reason: "response_failed", retryable: false,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, usageComplete: true
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("preserves hosted-effect uncertainty and sanitizes the terminal failure", async () => {
    const { model, fetcher } = setup([
      { type: "response.output_item.done", item: { type: "code_interpreter_call", id: "hosted-1", status: "completed" } },
      { type: "response.failed", response: { status: "failed", usage, error: { message: "secret-provider-payload" } } }
    ]);
    const failure = await streamText({ model, prompt: "test", maxRetries: 2 }).collect().catch(error => error);
    expect(failure).toMatchObject({ name: "ProviderToolCallError", effectsPossible: true, retryable: false, usageComplete: true, usage: { totalTokens: 15 } });
    expect(JSON.stringify(failure)).not.toContain("secret-provider-payload");
    expect(failure.message).not.toContain("secret-provider-payload");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("reports truncation and usage without releasing pending tool calls", async () => {
    const { model } = setup([call, { type: "response.incomplete", response: { status: "incomplete", usage, incomplete_details: { reason: "max_output_tokens" } } }]);
    const events: StreamEvent[] = [];
    for await (const event of await model.stream!(request)) events.push(event);
    expect(events).toEqual([{ type: "finish", finishReason: "length", providerFinishReason: "incomplete", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }]);
  });
  it("releases completed calls once with the matching finish reason", async () => {
    const { model, fetcher } = setup([call, { type: "response.completed", response: { status: "completed", usage } }]);
    const events: StreamEvent[] = [];
    for await (const event of await model.stream!(request)) events.push(event);
    expect(events[0]).toEqual({ type: "tool-call", toolCall: { id: "call_a", name: "weather", input: {} } });
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects a stream that closes before a terminal event", async () => {
    const { model } = setup([{ type: "response.output_text.delta", delta: "Partial" }]);
    await expect(streamText({ model, prompt: "test" }).collect()).rejects.toThrow("without a terminal event");
  });
});
