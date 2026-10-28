import { generateText, tool } from "@zhivex-ai/core";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  AppleLocalError,
  createAppleLocal,
  createAppleLocalInvokeTransport,
  createAppleLocalStdioTransport,
  type AppleLocalRequest,
  type AppleLocalServerMessage,
  type AppleLocalTransport
} from "../src/index.js";

const available = {
  available: true,
  imageInput: false,
  useCase: "general" as const,
  contextSize: 4096,
  supportedLanguages: ["en"]
};

const scripted = (
  handler: (request: AppleLocalRequest, calls: AppleLocalRequest[]) => AppleLocalServerMessage[]
): AppleLocalTransport & { calls: AppleLocalRequest[] } => {
  const calls: AppleLocalRequest[] = [];
  return {
    calls,
    async *send(request) {
      calls.push(structuredClone(request));
      for (const message of handler(request, calls)) yield message;
    }
  };
};

const statusThen = (
  result: AppleLocalServerMessage["result"] | undefined,
  status: AppleLocalServerMessage["result"] = available
) =>
  scripted((request) => {
    if (request.method === "status") return [{ id: request.id, result: status }];
    return [{ id: request.id, result: result! }];
  });

describe("apple-local adapter", () => {
  it("requires an injected transport and no API key", () => {
    expect(() => createAppleLocal({} as never)).toThrow(/transport/);
  });

  it("rejects unknown model ids before calling the bridge", async () => {
    const transport = scripted(() => []);
    const apple = createAppleLocal({ transport });
    expect(() => apple("gpt-4o")).toThrow(/apple-on-device/);
    expect(transport.calls).toHaveLength(0);
  });

  it("reports device, setting, and download availability failures without generating", async () => {
    for (const [reason, pattern] of [
      ["deviceNotEligible", /not available on this device/],
      ["appleIntelligenceNotEnabled", /turned off/],
      ["modelNotReady", /not ready/]
    ] as const) {
      const transport = scripted((request) => [
        { id: request.id, result: { available: false, reason, imageInput: false, useCase: "general" } }
      ]);
      const apple = createAppleLocal({ transport });
      await expect(apple.availability()).rejects.toThrow(pattern);
      await expect(apple("apple-on-device").generate({
        messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }]
      })).rejects.toBeInstanceOf(AppleLocalError);
      expect(transport.calls.every((call) => call.method === "status")).toBe(true);
    }
  });

  it("generates text and forwards temperature, maxTokens, and topP as nucleus sampling", async () => {
    const transport = statusThen({ text: "Hello", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });
    const apple = createAppleLocal({ transport });
    const result = await apple("system").generate({
      messages: [
        { role: "system", parts: [{ type: "text", text: "Be brief." }] },
        { role: "user", parts: [{ type: "text", text: "Hi" }] }
      ],
      temperature: 0.4,
      maxTokens: 32,
      topP: 0.2,
      seed: 7
    });
    expect(result.text).toBe("Hello");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 });
    const generate = transport.calls.find((call) => call.method === "generate");
    expect(generate?.params).toMatchObject({
      modelId: "system",
      useCase: "general",
      instructions: "Be brief.",
      prompt: { text: "Hi" },
      temperature: 0.4,
      maximumResponseTokens: 32,
      sampling: { mode: "random", probabilityThreshold: 0.2, seed: 7 }
    });
    expect(generate?.params).not.toHaveProperty("transcript", expect.arrayContaining([expect.objectContaining({ text: "Hi" })]));
  });

  it("returns tool calls and replays tool results as transcript entries", async () => {
    const transport = statusThen({
      finishReason: "tool-calls",
      toolCalls: [{ id: "call-1", name: "lookup", arguments: { city: "Madrid" } }]
    });
    const apple = createAppleLocal({ transport });
    const model = apple("apple-on-device");
    const first = await model.generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "Weather?" }] }],
      tools: {
        lookup: tool({
          name: "lookup",
          description: "Look up a city",
          schema: z.object({ city: z.string() }),
          execute: () => "sunny"
        })
      },
      toolChoice: "required"
    });
    expect(first.finishReason).toBe("tool-calls");
    expect(first.message?.parts).toContainEqual({
      type: "tool-call",
      toolCall: { id: "call-1", name: "lookup", input: { city: "Madrid" } }
    });
    expect(transport.calls.at(-1)?.params).toMatchObject({ toolCallingMode: "required" });

    const second = statusThen({ text: "Sunny in Madrid", finishReason: "stop" });
    const follow = createAppleLocal({ transport: second });
    await follow("apple-on-device").generate({
      messages: [
        { role: "user", parts: [{ type: "text", text: "Weather?" }] },
        { role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "call-1", name: "lookup", input: { city: "Madrid" } } }] },
        { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "call-1", toolName: "lookup", output: "sunny", isError: false } }] }
      ]
    });
    expect(second.calls.at(-1)?.params).toMatchObject({
      continuation: true,
      prompt: { text: "" },
      transcript: [
        { type: "prompt", text: "Weather?" },
        { type: "toolCalls", calls: [{ id: "call-1", name: "lookup", arguments: { city: "Madrid" } }] },
        { type: "toolOutput", id: "call-1", name: "lookup", output: "sunny" }
      ]
    });
  });

  it("rejects named tool choice, reasoning, permissive guided generation, and unsupported schemas", async () => {
    const transport = statusThen({ text: "nope", finishReason: "stop" });
    const model = createAppleLocal({ transport })("apple-on-device");
    const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "Hi" }] }];
    await expect(model.generate({
      messages,
      tools: { lookup: tool({ name: "lookup", schema: z.object({ city: z.string() }), execute: () => "ok" }) },
      toolChoice: { type: "tool", toolName: "lookup" }
    })).rejects.toThrow(/ToolCallingMode/);
    await expect(model.generate({ messages, reasoning: { effort: "high" } })).rejects.toThrow(/does not support reasoning/);
    await expect(model.generate({
      messages,
      providerOptions: { guardrails: "permissiveContentTransformations" },
      structuredOutput: { schema: z.object({ ok: z.boolean() }), mode: "native", name: "Answer" }
    })).rejects.toThrow(/permissiveContentTransformations/);
    await expect(model.generate({
      messages,
      structuredOutput: {
        schema: z.object({ note: z.string().regex(/a/) }).catchall(z.string()),
        mode: "native",
        name: "Answer"
      }
    })).rejects.toThrow(/additionalProperties|unsupported keyword/);
    expect(transport.calls).toHaveLength(0);
  });

  it("sends a guided-generation schema and refuses image bytes when the bridge has no image input", async () => {
    const transport = statusThen({ text: "{\"name\":\"Ada\"}", finishReason: "stop" });
    const model = createAppleLocal({ transport })("content-tagging");
    await model.generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "Tag this" }] }],
      structuredOutput: { schema: z.object({ name: z.string() }), mode: "native", name: "Tag" }
    });
    expect(transport.calls.at(-1)?.params).toMatchObject({
      useCase: "contentTagging",
      responseSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
    });

    await expect(model.generate({
      messages: [{ role: "user", parts: [{ type: "image", image: "abcd", mediaType: "image/png" }] }]
    })).rejects.toThrow(/image input/);
    expect(transport.calls.filter((call) => call.method === "generate")).toHaveLength(1);
  });

  it("forwards images only after the bridge reports image input", async () => {
    const transport = statusThen(
      { text: "A cat", finishReason: "stop" },
      { ...available, imageInput: true }
    );
    const bytes = Buffer.from("png").toString("base64");
    await createAppleLocal({ transport })("apple-on-device").generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "What is this?" }, { type: "image", image: bytes, mediaType: "image/png" }] }]
    });
    expect(transport.calls.at(-1)?.params).toMatchObject({
      prompt: { text: "What is this?", images: [{ mediaType: "image/png", data: bytes }] }
    });
  });

  it("fails early for audio, files, seeds without sampling, and unsupported locales", async () => {
    const transport = scripted((request) => [{
      id: request.id,
      result: { ...available, localeSupported: false }
    }]);
    const model = createAppleLocal({ transport })("apple-on-device");
    await expect(generateText({
      model,
      messages: [{ role: "user", parts: [{ type: "audio", data: "abc", mediaType: "audio/wav" }] }]
    })).rejects.toThrow(/audio/);
    await expect(model.generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
      seed: 1
    })).rejects.toThrow(/seed/);
    await expect(model.generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
      providerOptions: { locale: "xx-ZZ" }
    })).rejects.toThrow(/does not support locale/);
    expect(transport.calls.every((call) => call.method === "status")).toBe(true);
  });

  it("maps rate limits, guardrails, and streamed deltas", async () => {
    const limited = scripted((request) => [{
      id: request.id,
      error: { code: "rateLimited", message: "The session is rate limited.", retryAt: "2026-10-28T00:00:00.000Z" }
    }]);
    const apple = createAppleLocal({ transport: limited });
    await expect(apple.availability()).rejects.toMatchObject({
      code: "rateLimited",
      retryAt: "2026-10-28T00:00:00.000Z"
    });

    const transport = scripted((request) => {
      if (request.method === "status") return [{ id: request.id, result: available }];
      if (request.method === "stream") {
        return [
          { id: request.id, event: { type: "text-delta", textDelta: "Hel" } },
          { id: request.id, event: { type: "text-delta", textDelta: "lo" } },
          { id: request.id, result: { text: "Hello", finishReason: "stop", usage: { outputTokens: 1 } } }
        ];
      }
      return [{ id: request.id, error: { code: "guardrailViolation", message: "Guardrail violation." } }];
    });
    const model = createAppleLocal({ transport })("apple-on-device");
    const events = [];
    for await (const event of await model.stream({
      messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }]
    })) events.push(event);
    expect(events).toEqual([
      { type: "text-delta", textDelta: "Hel" },
      { type: "text-delta", textDelta: "lo" },
      { type: "finish", finishReason: "stop", usage: { outputTokens: 1 }, providerRequestCount: 1 }
    ]);
    await expect(model.generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }]
    })).rejects.toMatchObject({ code: "guardrailViolation" });
  });

  it("speaks newline-delimited JSON over stdio and accepts an invoke transport", async () => {
    const script = `
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        while (buffer.includes("\\n")) {
          const newline = buffer.indexOf("\\n");
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const request = JSON.parse(line);
          const result = request.method === "status"
            ? { available: true, imageInput: false, useCase: request.params.useCase }
            : { text: "from-stdio", finishReason: "stop" };
          process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
        }
      });
    `;
    const transport = createAppleLocalStdioTransport({
      command: process.execPath,
      args: ["--input-type=module", "-e", script]
    });
    try {
      const result = await createAppleLocal({ transport })("apple-on-device").generate({
        messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }]
      });
      expect(result.text).toBe("from-stdio");
    } finally {
      transport.close();
    }

    const invoke = createAppleLocalInvokeTransport({
      invoke: async (command, args) => {
        expect(command).toBe("apple_local_request");
        return [{ id: args.request.id, result: available }];
      }
    });
    await expect(createAppleLocal({ transport: invoke }).availability()).resolves.toMatchObject({ available: true });
  });
});
