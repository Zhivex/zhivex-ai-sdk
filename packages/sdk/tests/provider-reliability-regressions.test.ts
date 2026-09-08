import { expect, it, vi } from "vitest";
import { createOpenAI } from "../../openai/src/index.js";
import { createAnthropic } from "../../anthropic/src/index.js";
import { createQwen } from "../../qwen/src/index.js";
import { createGemini } from "../../gemini/src/index.js";
import { createMeta } from "../../meta/src/index.js";
import { createDeepSeek } from "../../deepseek/src/index.js";
import { createXAI } from "../../xai/src/index.js";
it.each([
  ["openai", createOpenAI, "gpt-4o-mini"], ["anthropic", createAnthropic, "claude-sonnet-4-6"],
  ["qwen", createQwen, "qwen-plus"], ["gemini", createGemini, "gemini-2.5-flash"]
] as const)("%s retries HTTP 503", async (_name, create, id) => {
  const fetch = vi.fn(async () => Response.json({ error: {message:"temporary"} }, {status:503}));
  const provider = create({apiKey:"FAKE_TEST",fetch:fetch as typeof globalThis.fetch});
  await expect(provider(id).generate({messages:[{role:"user",parts:[{type:"text",text:"hello"}]}],maxRetries:2,retryBackoffMs:0})).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([["meta",createMeta],["xai",createXAI]] as const)("%s uploads only the supplied byte view", async (_name, create) => {
  let uploaded = "";
  const fetch = vi.fn(async (_url:unknown, init?: RequestInit) => {
    uploaded = await ((init!.body as FormData).get("file") as Blob).text();
    return Response.json({id:"file-test",filename:"file.txt",bytes:3,purpose:"user_data",created_at:0});
  });
  const provider = create({apiKey:"FAKE_TEST",fetch:fetch as typeof globalThis.fetch});
  const all = new TextEncoder().encode("PRIVATE|PUBLIC|PRIVATE");
  await provider.files.upload({data:all.subarray(8,14),mediaType:"text/plain",filename:"file.txt"});
  expect(uploaded).toBe("PUBLIC");
});

it.each([false, true])("DeepSeek timeout interrupts retry backoff, streaming=%s", async (streaming)=>{
  vi.useFakeTimers();
  try {
    let signal:AbortSignal|undefined;
    const fetch=vi.fn(async (_url:unknown,init?:RequestInit)=>{
      signal=init?.signal ?? undefined;
      if(signal?.aborted) throw signal.reason;
      return Response.json({error:{message:"temporary"}},{status:503});
    });
    let settled=false;
    const model = createDeepSeek({ apiKey: "FAKE_TEST", fetch: fetch as typeof globalThis.fetch })("deepseek-chat");
    const input = {
      messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }],
      timeoutMs: 10, maxRetries: 1, retryBackoffMs: 1000
    };
    const result = (streaming ? model.stream(input) : model.generate(input))
      .catch(error => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(20);
    expect(signal?.aborted).toBe(true);
    expect(settled).toBe(true);
    await vi.advanceTimersByTimeAsync(980);
    expect((await result).name).toBe("TimeoutError");
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});


it.each([
  ["openai-chat", createOpenAI, "gpt-4o-mini", "chat"],
  ["openai-responses", createOpenAI, "gpt-4o-mini", "responses"],
  ["anthropic", createAnthropic, "claude-sonnet-4-6", undefined],
  ["qwen-chat", createQwen, "qwen-plus", "chat"],
  ["qwen-responses", createQwen, "qwen-plus", "responses"],
  ["gemini", createGemini, "gemini-2.5-flash", undefined]
] as const)("%s retries streaming startup but not permanent HTTP errors", async (_name, create, id, apiMode) => {
  for (const status of [400, 503]) {
    const fetch = vi.fn(async () => Response.json({ error: { message: "failure" } }, { status }));
    const provider = create({ apiKey: "FAKE_TEST", fetch: fetch as typeof globalThis.fetch });
    await expect(provider(id).stream!({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      maxRetries: 2, retryBackoffMs: 0,
      ...(apiMode ? { providerOptions: { apiMode } } : {})
    })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(status === 400 ? 1 : 3);
  }
});

it.each([false, true])("byte uploads preserve Buffer slices too, xai=%s", async (xai) => {
  let uploaded = "";
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    uploaded = await ((init!.body as FormData).get("file") as Blob).text();
    return Response.json({ id: "file-test", filename: "file.txt", bytes: 6, created_at: 0 });
  });
  const provider = (xai ? createXAI : createMeta)({ apiKey: "FAKE_TEST", fetch: fetch as typeof globalThis.fetch });
  const buffer = Buffer.from("PRIVATE|PUBLIC|PRIVATE");
  await provider.files.upload({ data: buffer.subarray(8, 14), mediaType: "text/plain" });
  expect(uploaded).toBe("PUBLIC");
});
