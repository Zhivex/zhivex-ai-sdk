import { describe, expect, it } from "vitest";

import {
  openAICompatibleJsonHeaders,
  openAICompatibleReasoningContent,
  openOpenAICompatibleEvents,
  openOpenAICompatibleStream,
  streamOpenAICompatibleChat,
  withOpenAICompatibleAttempt
} from "../src/openai-compatible.js";
import { providerDataPart } from "../src/messages.js";
import type { StreamEvent } from "../src/types.js";

const sse = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/event-stream" } });

const collect = async (events: AsyncIterable<StreamEvent>) => {
  const collected: StreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

describe("OpenAI-compatible adapter base", () => {
  it("shares bearer headers and provider reasoning text", () => {
    expect(openAICompatibleJsonHeaders("secret")).toEqual({
      "content-type": "application/json",
      authorization: "Bearer secret"
    });
    expect(openAICompatibleReasoningContent({
      role: "assistant",
      parts: [
        providerDataPart("kimi", { type: "reasoning_content", reasoningContent: "think" }),
        providerDataPart("other", { type: "reasoning_content", reasoningContent: "no" }),
        { type: "text", text: "answer" }
      ]
    }, "kimi")).toBe("think");
  });

  it("stops at DONE and lets the profile own chunk and finish events", async () => {
    const events = await collect(streamOpenAICompatibleChat(sse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
      'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n'
    ].join("")), {
      readPayload: (data) => JSON.parse(data),
      onChunk: (payload) => payload.choices[0].delta.content
        ? [{ type: "text-delta", textDelta: payload.choices[0].delta.content }]
        : [],
      onDone: () => [{ type: "finish", finishReason: "stop", providerFinishReason: "stop" }]
    }));
    expect(events).toEqual([
      { type: "text-delta", textDelta: "hi" },
      { type: "finish", finishReason: "stop", providerFinishReason: "stop" }
    ]);
  });

  it("releases the timeout after a successful attempt and a failed stream open", async () => {
    await expect(withOpenAICompatibleAttempt({}, async () => "ok")).resolves.toBe("ok");
    await expect(withOpenAICompatibleAttempt({}, async () => {
      throw new Error("attempt failed");
    }, () => new Error("normalized"))).rejects.toThrow("normalized");

    const streamed = await openOpenAICompatibleStream({}, async () => sse('data: {"ok":true}\n\ndata: [DONE]\n\n'), {
      readPayload: (data) => JSON.parse(data),
      onChunk: () => [],
      onDone: () => [{ type: "finish", finishReason: "stop" }]
    });
    expect(await collect(streamed)).toEqual([{ type: "finish", finishReason: "stop" }]);
    await expect(openOpenAICompatibleStream({}, async () => {
      throw new Error("open failed");
    })).rejects.toThrow("open failed");

    const native = await openOpenAICompatibleEvents({}, async () => (async function* () {
      yield { type: "text-delta", textDelta: "native" } satisfies StreamEvent;
    })());
    expect(await collect(native)).toEqual([{ type: "text-delta", textDelta: "native" }]);
  });
});