import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CallbackRealtimeSession,
  createInMemoryAgentRunStore,
  streamLiveAgent,
  tool
} from "../src/index.js";
import type {
  RealtimeConnection,
  RealtimeModel,
  RealtimeSession,
  RealtimeSessionConfig,
  RealtimeTokenResult,
  ToolExecutionResult
} from "../src/index.js";

describe("realtime helpers", () => {
  it("broadcasts callback realtime session events and sent payloads", async () => {
    const sent: Record<string, unknown>[] = [];
    const received = [
      { type: "message", text: "hello" },
      { type: "provider-event", status: "in_progress" },
      { type: "done" }
    ];
    const connection: RealtimeConnection = {
      async sendJson(payload) {
        sent.push(payload);
      },
      async recvJson() {
        return received.shift();
      },
      async close() {}
    };

    const session = new CallbackRealtimeSession({
      provider: "test",
      modelId: "realtime-test",
      capabilities: {
        streaming: false,
        tools: true,
        structuredOutput: false,
        jsonMode: false,
        toolChoice: true,
        parallelToolCalls: false,
        vision: false,
        files: false,
        audioInput: true,
        audioOutput: true,
        embeddings: false,
        reasoning: false,
        webSearch: false
      },
      config: {},
      connection,
      callbacks: {
        parseEvent(payload) {
          if (payload.type === "message") {
            return [{ type: "realtime-text-delta", textDelta: String(payload.text ?? "") }];
          }
          if (payload.type === "provider-event") {
            return [
              {
                type: "realtime-provider-data",
                provider: "test",
                data: { type: "provider-event", status: String(payload.status ?? "") }
              }
            ];
          }
          if (payload.type === "done") {
            return [{ type: "realtime-end", reason: "stop" }];
          }
          return [];
        },
        buildAudioPayloads: () => [{ type: "audio" }],
        buildMediaPayloads: (frame) => [{ type: "media", mediaType: frame.mediaType }],
        buildTextPayloads: (text) => [{ type: "text", text }],
        buildToolResultPayloads: (result) => [{ type: "tool", id: result.toolCallId }],
        buildUpdatePayloads: () => [{ type: "update" }],
        buildInitialPayloads: () => [{ type: "init" }]
      }
    });

    await session.initialize();
    await session.sendMedia({ data: "image-bytes", mediaType: "image/jpeg" });
    await session.sendText("hello");

    const events = [];
    for await (const event of session.eventStream()) {
      events.push(event.type);
    }

    expect(sent).toEqual([{ type: "init" }, { type: "media", mediaType: "image/jpeg" }, { type: "text", text: "hello" }]);
    expect(events).toContain("realtime-start");
    expect(events).toContain("realtime-text-delta");
    expect(events).toContain("realtime-provider-data");
    expect(events.at(-1)).toBe("realtime-end");
  });

  it("rejects unsupported non-audio media input explicitly", async () => {
    const session = new CallbackRealtimeSession({
      provider: "test",
      modelId: "realtime-test",
      capabilities: {
        streaming: false,
        tools: false,
        structuredOutput: false,
        jsonMode: false,
        toolChoice: false,
        parallelToolCalls: false,
        vision: false,
        files: false,
        audioInput: true,
        audioOutput: false,
        embeddings: false,
        reasoning: false,
        webSearch: false
      },
      config: {},
      connection: {
        async sendJson() {},
        async recvJson() {
          return undefined;
        },
        async close() {}
      },
      callbacks: {
        parseEvent: () => [],
        buildAudioPayloads: () => [{ type: "audio" }],
        buildTextPayloads: () => [{ type: "text" }],
        buildToolResultPayloads: () => [{ type: "tool" }],
        buildUpdatePayloads: () => [{ type: "update" }]
      }
    });

    await session.initialize();

    await expect(session.sendMedia({ data: "image", mediaType: "image/jpeg" })).rejects.toThrow(
      'Realtime media input is not supported for provider "test"'
    );
  });

  it("streams live agents, executes local tools, and persists final state", async () => {
    const sentTexts: string[] = [];
    const sentToolResults: ToolExecutionResult[] = [];
    let closed = false;

    const session: RealtimeSession = {
      provider: "test",
      modelId: "live-model",
      capabilities: {
        streaming: false,
        tools: true,
        structuredOutput: false,
        jsonMode: false,
        toolChoice: true,
        parallelToolCalls: false,
        vision: false,
        files: false,
        audioInput: true,
        audioOutput: true,
        embeddings: false,
        reasoning: false,
        webSearch: false
      },
      config: {},
      async sendAudio() {},
      async sendMedia() {},
      async sendText(text) {
        sentTexts.push(text);
      },
      async sendToolResult(result) {
        sentToolResults.push(result);
      },
      async update() {},
      eventStream() {
        return (async function* () {
          yield { type: "realtime-start" } as const;
          yield {
            type: "realtime-tool-call",
            toolCall: { id: "call_1", name: "weather", input: { city: "Madrid" } }
          } as const;
          yield { type: "realtime-text-delta", textDelta: "Madrid " } as const;
          yield { type: "realtime-text-delta", textDelta: "is sunny" } as const;
          yield {
            type: "realtime-transcript",
            text: "Madrid is sunny",
            role: "assistant",
            isFinal: true
          } as const;
          yield { type: "realtime-response-complete", reason: "turn-complete" } as const;
        })();
      },
      async close() {
        closed = true;
      }
    };

    const model: RealtimeModel = {
      provider: "test",
      modelId: "live-model",
      capabilities: session.capabilities,
      async connect(_config?: RealtimeSessionConfig): Promise<RealtimeSession> {
        return session;
      },
      async createBrowserToken(): Promise<RealtimeTokenResult> {
        return { value: "token" };
      }
    };

    const store = createInMemoryAgentRunStore();
    const stream = streamLiveAgent(
      {
        id: "agent-live",
        model,
        instructions: "Be concise.",
        tools: {
          weather: tool({
            name: "weather",
            schema: z.object({ city: z.string() }),
            execute: ({ city }) => ({ forecast: `${city} is sunny` })
          })
        },
        store
      },
      {
        prompt: "How is Madrid?"
      }
    );

    const chunks: string[] = [];
    for await (const chunk of stream.textStream) {
      chunks.push(chunk);
    }
    const result = await stream.collect();

    expect(chunks.join("")).toBe("Madrid is sunny");
    expect(sentTexts).toEqual(["How is Madrid?"]);
    expect(sentToolResults).toEqual([
      {
        toolCallId: "call_1",
        toolName: "weather",
        output: { forecast: "Madrid is sunny" },
        isError: false
      }
    ]);
    expect(result.outputText).toBe("Madrid is sunny");
    expect(result.state.runId).toMatch(
      /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(result.toolResults).toHaveLength(1);
    expect(result.messages.at(-1)?.role).toBe("assistant");
    expect(closed).toBe(true);
    expect(store.load(result.state.runId)).toMatchObject({
      status: "completed",
      outputText: "Madrid is sunny"
    });
  });
});
