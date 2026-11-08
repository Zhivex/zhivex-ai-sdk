import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { toAISDKUIMessageStream } from "../src/compat.js";
import type { ChatStreamChunk } from "../src/types.js";

/** AI SDK 7.0.163 added this text-stream heartbeat. It is not a UI message chunk. */
const isTextStreamPing = (part: TextStreamPart<ToolSet>) => part.type === "ping";

describe("AI SDK text-stream ping", () => {
  it("accepts the ping variant and leaves it off the UI message stream", async () => {
    expect(isTextStreamPing({ type: "ping" })).toBe(true);
    const source = (async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { type: "text-delta", textDelta: "ok" } as ChatStreamChunk;
      yield { type: "finish", finishReason: "stop" } as ChatStreamChunk;
    })();
    const types: string[] = [];
    for await (const chunk of toAISDKUIMessageStream(source)) types.push(chunk.type);
    expect(types).toEqual(["start", "text-start", "text-delta", "text-end", "finish"]);
    expect(types).not.toContain("ping");
  });
});
