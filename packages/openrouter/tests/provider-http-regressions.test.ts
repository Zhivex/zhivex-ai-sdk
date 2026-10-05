import { afterEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel, ModelGenerateInput } from "@zhivex-ai/core";
import { createOpenRouter } from "../src/index.js";
import { createKimi } from "../../kimi/src/index.js";
import { createAzureOpenAI } from "../../azure-openai/src/index.js";
import { createBedrock } from "../../bedrock/src/index.js";
import { createOllama } from "../../ollama/src/index.js";

const input: ModelGenerateInput = { messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }], maxRetries: 2, retryBackoffMs: 0 };
const sse = (chunks: unknown[]) => chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
const chat = { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] };
const terminal = { type: "response.completed", response: { status: "completed" } };
const cases: Array<{ name: string; model: (fetch: typeof globalThis.fetch) => LanguageModel; json: unknown; stream: string; partial: string }> = [
  { name: "OpenRouter", model: fetch => createOpenRouter({ apiKey: "test", fetch })("openai/gpt-4o-mini"), json: chat, stream: sse([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]), partial: sse([{ choices: [{ delta: { content: "partial" } }] }]) },
  { name: "Kimi", model: fetch => createKimi({ apiKey: "test", fetch })("moonshot-v1-8k"), json: chat, stream: sse([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]), partial: sse([{ choices: [{ delta: { content: "partial" } }] }]) },
  { name: "Azure", model: fetch => createAzureOpenAI({ apiKey: "test", endpoint: "https://test.openai.azure.com", fetch })("gpt-4o-mini"), json: chat, stream: sse([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]), partial: sse([{ choices: [{ delta: { content: "partial" } }] }]) },
  { name: "Azure Responses", model: fetch => createAzureOpenAI({ apiKey: "test", endpoint: "https://test.openai.azure.com", fetch })("gpt-6-astra"), json: { status: "completed", output: [] }, stream: sse([terminal]), partial: sse([{ type: "response.output_text.delta", delta: "partial" }]) },
  { name: "Bedrock OpenAI", model: fetch => createBedrock({ runtime: "openai", apiKey: "test", baseURL: "https://bedrock.example.com", fetch })("openai.gpt-oss-120b-1:0"), json: { status: "completed", output: [] }, stream: sse([terminal]), partial: sse([{ type: "response.output_text.delta", delta: "partial" }]) },
  { name: "Ollama", model: fetch => createOllama({ fetch })("llama3.2"), json: { message: { content: "OK" }, done_reason: "stop" }, stream: JSON.stringify({ message: { content: "OK" }, done: true, done_reason: "stop" }) + "\n", partial: JSON.stringify({ message: { content: "partial" } }) + "\n" }
];
afterEach(() => vi.useRealTimers());
for (const adapter of cases) describe(`${adapter.name} HTTP retry boundary`, () => {
  for (const operation of ["generate", "stream"] as const) {
    const invoke = async (fetcher: typeof fetch, options: Partial<ModelGenerateInput> = {}) => {
      const model = adapter.model(fetcher);
      if (operation === "generate") return model.generate({ ...input, ...options });
      const events = [];
      for await (const event of await model.stream!({ ...input, ...options })) events.push(event);
      return events;
    };
    const success = () => operation === "generate" ? Response.json(adapter.json) : new Response(adapter.stream);
    it(`${operation} retries HTTP 503 before consuming the successful response`, async () => {
      const fetcher = vi.fn().mockResolvedValueOnce(new Response("temporary", { status: 503 })).mockImplementationOnce(async () => success());
      await invoke(fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it(`${operation} does not retry authentication errors`, async () => {
      const fetcher = vi.fn().mockResolvedValue(new Response("denied", { status: 401 }));
      await expect(invoke(fetcher)).rejects.toMatchObject({ status: 401 });
      expect(fetcher).toHaveBeenCalledOnce();
    });
    it(`${operation} preserves maxRetries=0`, async () => {
      const fetcher = vi.fn().mockResolvedValue(new Response("temporary", { status: 503 }));
      await expect(invoke(fetcher, { maxRetries: 0 })).rejects.toMatchObject({ status: 503 });
      expect(fetcher).toHaveBeenCalledOnce();
    });
    it(`${operation} honors Retry-After`, async () => {
      vi.useFakeTimers();
      const fetcher = vi.fn().mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "retry-after": "1" } })).mockImplementationOnce(async () => success());
      const pending = invoke(fetcher);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetcher).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it(`${operation} cancels retry backoff on deadline`, async () => {
      vi.useFakeTimers();
      const fetcher = vi.fn().mockImplementation(async () => new Response("temporary", { status: 503 }));
      const pending = expect(invoke(fetcher, { timeoutMs: 10, retryBackoffMs: 1000 })).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(10);
      await pending;
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });
    it(`${operation} does not dispatch after caller cancellation`, async () => {
      const controller = new AbortController(); controller.abort(new Error("cancelled"));
      const fetcher = vi.fn();
      await expect(invoke(fetcher, { abortSignal: controller.signal })).rejects.toThrow("cancelled");
      expect(fetcher).not.toHaveBeenCalled();
    });
  }
  it("releases listeners and timers when stream opening rejects", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener"), remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(adapter.model(fetcher).stream!({ ...input, timeoutMs: 1000, abortSignal: controller.signal })).rejects.toThrow("offline");
    const listener = add.mock.calls.find(([event]) => event === "abort")![1];
    expect(remove).toHaveBeenCalledWith("abort", listener);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("never retries after delivering part of a successful HTTP stream", async () => {
    const malformed = adapter.name === "Ollama" ? "not-json\n" : "data: not-json\n\n";
    const fetcher = vi.fn().mockImplementation(async () => new Response(adapter.partial + malformed));
    const iterator = (await adapter.model(fetcher).stream!(input))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "text-delta", textDelta: "partial" });
    await expect(iterator.next()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
