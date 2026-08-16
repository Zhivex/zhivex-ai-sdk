import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CallbackRealtimeSession,
  createInMemoryAgentRunStore,
  streamLiveAgent,
  tool
} from "../src/index.js";
import type {
  AgentLiveEvent,
  ModelCapabilities,
  RealtimeConnection,
  RealtimeEvent,
  RealtimeModel,
  RealtimeSession,
  RealtimeSessionCallbacks,
  RealtimeSessionConfig,
  RealtimeTokenResult,
  ToolExecutionResult
} from "../src/index.js";

const liveCapabilities = {
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
} as const;

const collectAsync = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
};

const realtimeCapabilities = {
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
} satisfies ModelCapabilities;

const createRealtimeCallbacks = (
  overrides: Partial<RealtimeSessionCallbacks> = {}
): RealtimeSessionCallbacks => ({
  parseEvent: () => [],
  buildAudioPayloads: () => [{ type: "audio" }],
  buildMediaPayloads: () => [{ type: "media" }],
  buildTextPayloads: (text) => [{ type: "text", text }],
  buildToolResultPayloads: (result) => [{ type: "tool-result", id: result.toolCallId }],
  buildUpdatePayloads: () => [{ type: "update" }],
  ...overrides
});

const collectRealtimeEvents = async (session: RealtimeSession) => {
  const events: RealtimeEvent[] = [];
  for await (const event of session.eventStream()) {
    events.push(event);
  }
  return events;
};

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

  it("waits for the provider setup acknowledgement before opening a session", async () => {
    let acknowledgeSetup: (() => void) | undefined;
    let finishReceive: (() => void) | undefined;
    let receives = 0;
    const setupAcknowledgement = new Promise<void>((resolve) => {
      acknowledgeSetup = resolve;
    });
    const pendingReceive = new Promise<undefined>((resolve) => {
      finishReceive = () => resolve(undefined);
    });
    const session = new CallbackRealtimeSession({
      provider: "test",
      modelId: "realtime-test",
      capabilities: realtimeCapabilities,
      config: {},
      connection: {
        async sendJson() {},
        async recvJson() {
          receives += 1;
          if (receives === 1) {
            await setupAcknowledgement;
            return { setupComplete: {} };
          }
          return pendingReceive;
        },
        async close() {
          finishReceive?.();
        }
      },
      callbacks: createRealtimeCallbacks({
        isReadyPayload: (payload) => "setupComplete" in payload,
        buildInitialPayloads: () => [{ type: "setup" }]
      })
    });

    let initialized = false;
    const initialize = session.initialize().then(() => {
      initialized = true;
    });
    await Promise.resolve();
    await expect(session.sendText("too early")).rejects.toThrow("not open");
    expect(initialized).toBe(false);

    acknowledgeSetup?.();
    await initialize;
    expect(initialized).toBe(true);
    await session.sendText("ready");
    await session.close();
  });

  it("fails closed when a provider never acknowledges setup", async () => {
    let closeCalls = 0;
    const session = new CallbackRealtimeSession({
      provider: "test",
      modelId: "realtime-test",
      capabilities: realtimeCapabilities,
      config: {},
      initializationTimeoutMs: 10,
      connection: {
        async sendJson() {},
        async recvJson() {
          return new Promise<never>(() => {});
        },
        async close() {
          closeCalls += 1;
        }
      },
      callbacks: createRealtimeCallbacks({
        isReadyPayload: (payload) => "setupComplete" in payload,
        buildInitialPayloads: () => [{ type: "setup" }]
      })
    });

    await expect(session.initialize()).rejects.toThrow(
      "Realtime provider setup timed out after 10ms"
    );
    expect(closeCalls).toBe(1);
    await expect(session.sendText("late")).rejects.toThrow("not open");
  });

  it("rejects unsupported non-audio media input explicitly", async () => {
    let finishReceive: ((value: undefined) => void) | undefined;
    const receive = new Promise<undefined>((resolve) => {
      finishReceive = resolve;
    });
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
          return receive;
        },
        async close() {
          finishReceive?.(undefined);
        },
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
    await session.close();
  });

  it("fails initialization closed when the initial transport send fails", async () => {
    let closeCalls = 0;
    const connection: RealtimeConnection = {
      async sendJson() {
        throw new Error("initial send failed");
      },
      async recvJson() {
        return undefined;
      },
      async close() {
        closeCalls += 1;
      }
    };
    const session = new CallbackRealtimeSession({
      provider: "test",
      modelId: "realtime-test",
      capabilities: realtimeCapabilities,
      config: {},
      connection,
      callbacks: createRealtimeCallbacks({
        buildInitialPayloads: () => [{ type: "init" }]
      })
    });
    const eventsPromise = collectRealtimeEvents(session);

    await expect(session.initialize()).rejects.toThrow("initial send failed");
    const events = await eventsPromise;

    expect(events.map((event) => event.type)).toEqual(["realtime-error", "realtime-end"]);
    expect(events.at(-1)).toMatchObject({ type: "realtime-end", reason: "error" });
    expect(closeCalls).toBe(1);
    await expect(session.sendText("late")).rejects.toThrow("not open");
  });

  it("terminates and closes the connection when receive or provider parsing fails", async () => {
    for (const failureMode of ["receive", "provider"] as const) {
      let closeCalls = 0;
      let receives = 0;
      const connection: RealtimeConnection = {
        async sendJson() {},
        async recvJson() {
          receives += 1;
          if (failureMode === "receive") {
            throw new Error("receive failed");
          }
          return receives === 1 ? { type: "provider-error" } : new Promise<never>(() => {});
        },
        async close() {
          closeCalls += 1;
        }
      };
      const session = new CallbackRealtimeSession({
        provider: "test",
        modelId: "realtime-test",
        capabilities: realtimeCapabilities,
        config: {},
        connection,
        callbacks: createRealtimeCallbacks({
          parseEvent: () => failureMode === "provider"
            ? [{ type: "realtime-error", message: "provider failed" }]
            : []
        })
      });

      await session.initialize();
      const events = await collectRealtimeEvents(session);

      expect(events.map((event) => event.type)).toEqual([
        "realtime-start",
        "realtime-error",
        "realtime-end"
      ]);
      expect(events.at(-1)).toMatchObject({ type: "realtime-end", reason: "error" });
      expect(closeCalls).toBe(1);
    }
  });

  it("closes event streams without awaiting a stuck custom receiver", async () => {
    let closeCalls = 0;
    const connection: RealtimeConnection = {
      async sendJson() {},
      async recvJson() {
        return new Promise<never>(() => {});
      },
      async close() {
        closeCalls += 1;
      }
    };
    const session = new CallbackRealtimeSession({
      provider: "test",
      modelId: "realtime-test",
      capabilities: realtimeCapabilities,
      config: {},
      connection,
      callbacks: createRealtimeCallbacks()
    });

    await session.initialize();
    const eventsPromise = collectRealtimeEvents(session);
    await session.close();
    const events = await eventsPromise;

    expect(events.map((event) => event.type)).toEqual(["realtime-start", "realtime-end"]);
    expect(events.at(-1)).toMatchObject({ type: "realtime-end", reason: "client-close" });
    expect(closeCalls).toBe(1);
  });

  it("turns outbound transport failures into terminal stream errors", async () => {
    let closeCalls = 0;
    let rejectSends = false;
    const connection: RealtimeConnection = {
      async sendJson() {
        if (rejectSends) {
          throw new Error("send failed");
        }
      },
      async recvJson() {
        return new Promise<never>(() => {});
      },
      async close() {
        closeCalls += 1;
      }
    };
    const session = new CallbackRealtimeSession({
      provider: "test",
      modelId: "realtime-test",
      capabilities: realtimeCapabilities,
      config: {},
      connection,
      callbacks: createRealtimeCallbacks()
    });

    await session.initialize();
    const eventsPromise = collectRealtimeEvents(session);
    rejectSends = true;
    await expect(session.sendText("hello")).rejects.toThrow("send failed");
    const events = await eventsPromise;

    expect(events.map((event) => event.type)).toEqual([
      "realtime-start",
      "realtime-error",
      "realtime-end"
    ]);
    expect(closeCalls).toBe(1);
  });

  it("delivers terminal error events to a saturated subscriber before closing", async () => {
    let received = 0;
    let markQueueSaturated: (() => void) | undefined;
    const queueSaturated = new Promise<void>((resolve) => {
      markQueueSaturated = resolve;
    });
    const connection: RealtimeConnection = {
      async sendJson() {},
      async recvJson() {
        if (received < 256) {
          received += 1;
          return { sequence: received };
        }
        markQueueSaturated?.();
        throw new Error("receive failed after saturation");
      },
      async close() {}
    };
    const session = new CallbackRealtimeSession({
      provider: "test",
      modelId: "realtime-test",
      capabilities: realtimeCapabilities,
      config: {},
      connection,
      callbacks: createRealtimeCallbacks({
        parseEvent: (payload) => [{
          type: "realtime-provider-data",
          provider: "test",
          data: payload
        }]
      })
    });
    const iterator = session.eventStream()[Symbol.asyncIterator]();
    const firstEvent = iterator.next();

    await session.initialize();
    await expect(firstEvent).resolves.toMatchObject({
      done: false,
      value: { type: "realtime-start" }
    });
    await queueSaturated;

    const remainingEvents: RealtimeEvent[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      remainingEvents.push(next.value);
    }

    expect(remainingEvents.filter((event) => event.type === "realtime-provider-data")).toHaveLength(256);
    expect(remainingEvents.slice(-2).map((event) => event.type)).toEqual([
      "realtime-error",
      "realtime-end"
    ]);
    expect(remainingEvents.at(-1)).toMatchObject({ type: "realtime-end", reason: "error" });
  });

  it("deduplicates identical realtime tool calls and fails closed on conflicting reuse", async () => {
    const received: unknown[] = [
      { id: "call_1", input: { value: 1 } },
      { id: "call_1", input: { value: 1 } },
      { id: "call_1", input: { value: 2 } },
      undefined
    ];
    const connection: RealtimeConnection = {
      async sendJson() {},
      async recvJson() {
        return received.shift();
      },
      async close() {}
    };
    const session = new CallbackRealtimeSession({
      provider: "test",
      modelId: "realtime-test",
      capabilities: realtimeCapabilities,
      config: {},
      connection,
      callbacks: createRealtimeCallbacks({
        parseEvent: (payload) => [{
          type: "realtime-tool-call",
          toolCall: {
            id: String(payload.id),
            name: "duplicate_tool",
            input: payload.input as { value: number }
          }
        }]
      })
    });

    await session.initialize();
    const events = await collectRealtimeEvents(session);
    const toolCalls = events.filter((event) => event.type === "realtime-tool-call");

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      toolCall: {
        id: "call_1",
        input: { value: 1 }
      }
    });
    expect(events.slice(-2).map((event) => event.type)).toEqual([
      "realtime-error",
      "realtime-end"
    ]);
    expect(events.at(-2)).toMatchObject({
      message: 'Realtime tool call id "call_1" was reused with a different payload.'
    });
    expect(events.at(-1)).toMatchObject({ type: "realtime-end", reason: "error" });
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

  it("waits through Gemini generation and turn completions, then deduplicates tool calls durably", async () => {
    const sentToolResults: ToolExecutionResult[] = [];
    const executionContexts: Array<Record<string, unknown> | undefined> = [];
    const execute = vi.fn((input: { value: number }, context?: Record<string, unknown>) => {
      executionContexts.push(context);
      return { doubled: input.value * 2 };
    });
    const session: RealtimeSession = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      config: {},
      async sendAudio() {},
      async sendMedia() {},
      async sendText() {},
      async sendToolResult(result) {
        sentToolResults.push(result);
      },
      async update() {},
      eventStream() {
        return (async function* () {
          const toolCall = { id: "call_duplicate", name: "double", input: { value: 4 } };
          yield { type: "realtime-tool-call", toolCall } as const;
          yield { type: "realtime-tool-call", toolCall } as const;
          yield { type: "realtime-response-complete", reason: "generation-complete" } as const;
          yield { type: "realtime-response-complete", reason: "turn-complete" } as const;
          yield { type: "realtime-text-delta", textDelta: "The answer is 8" } as const;
          yield {
            type: "realtime-transcript",
            role: "assistant",
            text: "The answer is 8",
            isFinal: true
          } as const;
          yield { type: "realtime-response-complete", reason: "generation-complete" } as const;
          yield { type: "realtime-response-complete", reason: "turn-complete" } as const;
        })();
      },
      async close() {}
    };
    const model: RealtimeModel = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      async connect() {
        return session;
      }
    };
    const store = createInMemoryAgentRunStore();
    const stream = streamLiveAgent(
      {
        model,
        tools: { double: tool({ name: "double", schema: z.object({ value: z.number() }), execute }) },
        store
      },
      {
        runId: "live-deduplicated",
        idempotencyKey: "request-deduplicated",
        scope: { tenantId: "tenant-a", userId: "user-a" },
        prompt: "Double four"
      }
    );

    const result = await stream.collect();
    const journal = await store.listToolCalls!("live-deduplicated", { tenantId: "tenant-a", userId: "user-a" });

    expect(result.outputText).toBe("The answer is 8");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sentToolResults).toHaveLength(1);
    expect(journal).toMatchObject([
      {
        toolCallId: "call_duplicate",
        status: "completed",
        idempotencyKey: "request-deduplicated:call_duplicate",
        output: { doubled: 8 }
      }
    ]);
    expect(executionContexts[0]).toMatchObject({
      runId: "live-deduplicated",
      scope: { tenantId: "tenant-a", userId: "user-a" },
      idempotencyKey: "request-deduplicated:call_duplicate"
    });
  });

  it("sends one active user turn and exposes prior messages and memory as provider context", async () => {
    const sentTexts: string[] = [];
    let connectedConfig: RealtimeSessionConfig | undefined;
    const session: RealtimeSession = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      config: {},
      async sendAudio() {},
      async sendMedia() {},
      async sendText(text) {
        sentTexts.push(text);
      },
      async sendToolResult() {},
      async update() {},
      eventStream() {
        return (async function* () {
          yield { type: "realtime-text-delta", textDelta: "latest answer" } as const;
          yield {
            type: "realtime-transcript",
            role: "assistant",
            text: "latest answer",
            isFinal: true
          } as const;
          yield { type: "realtime-response-complete", reason: "turn-complete" } as const;
        })();
      },
      async close() {}
    };
    const model: RealtimeModel = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      async connect(config) {
        connectedConfig = config;
        return session;
      }
    };
    const stream = streamLiveAgent(
      {
        model,
        memory: {
          load: () => [
            { role: "user", parts: [{ type: "text", text: "memory question" }] },
            { role: "assistant", parts: [{ type: "text", text: "memory answer" }] }
          ]
        }
      },
      {
        messages: [
          { role: "user", parts: [{ type: "text", text: "old question" }] },
          { role: "assistant", parts: [{ type: "text", text: "old answer" }] },
          { role: "user", parts: [{ type: "text", text: "latest question" }] }
        ]
      }
    );

    const result = await stream.collect();

    expect(sentTexts).toEqual(["latest question"]);
    expect(connectedConfig?.instructions).toContain("user: memory question");
    expect(connectedConfig?.instructions).toContain("assistant: memory answer");
    expect(connectedConfig?.instructions).toContain("user: old question");
    expect(connectedConfig?.instructions).toContain("assistant: old answer");
    expect(connectedConfig?.instructions).not.toContain("user: latest question");
    expect(result.messages.some((message) =>
      message.parts.some((part) => part.type === "text" && part.text === "memory answer")
    )).toBe(true);
  });

  it("fails closed when a live approval policy requests a resumable approval", async () => {
    const execute = vi.fn(() => ({ changed: true }));
    const sentToolResults: ToolExecutionResult[] = [];
    let closed = false;
    const session: RealtimeSession = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      config: {},
      async sendAudio() {},
      async sendMedia() {},
      async sendText() {},
      async sendToolResult(result) {
        sentToolResults.push(result);
      },
      async update() {},
      eventStream() {
        return (async function* () {
          yield {
            type: "realtime-tool-call",
            toolCall: { id: "approval-call", name: "dangerous", input: {} }
          } as const;
        })();
      },
      async close() {
        closed = true;
      }
    };
    const model: RealtimeModel = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      async connect() {
        return session;
      }
    };
    const store = createInMemoryAgentRunStore();
    const stream = streamLiveAgent(
      {
        model,
        tools: { dangerous: tool({ name: "dangerous", schema: z.object({}), execute }) },
        store,
        toolApprovalPolicy: () => ({ approved: false, approvalRequired: true, reason: "human review" })
      },
      { runId: "approval-run", prompt: "do it" }
    );

    await expect(stream.collect()).rejects.toThrow("only supports immediate approval decisions");
    expect(execute).not.toHaveBeenCalled();
    expect(sentToolResults).toEqual([]);
    expect(closed).toBe(true);
    expect(await store.load("approval-run")).toMatchObject({ status: "failed" });
  });

  it("settles session and both streams when connect fails before a session exists", async () => {
    const store = createInMemoryAgentRunStore();
    const model: RealtimeModel = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      async connect() {
        throw new Error("preconnect failed");
      }
    };
    const stream = streamLiveAgent({ model, store }, { runId: "preconnect-run", prompt: "hello" });
    const eventPromise = collectAsync(stream.eventStream);
    const textPromise = collectAsync(stream.textStream);

    const [collected, connected, events, text] = await Promise.allSettled([
      stream.collect(),
      stream.session,
      eventPromise,
      textPromise
    ]);

    expect(collected).toMatchObject({ status: "rejected", reason: { message: "preconnect failed" } });
    expect(connected).toMatchObject({ status: "rejected", reason: { message: "preconnect failed" } });
    expect(events).toMatchObject({ status: "fulfilled" });
    expect(text).toEqual({ status: "fulfilled", value: [] });
    expect(await store.load("preconnect-run")).toMatchObject({ status: "failed" });
  });

  it("propagates the lifetime timeout, persists timed_out, and closes all live outputs", async () => {
    let releaseEvents!: () => void;
    let closed = 0;
    let connectSignal: AbortSignal | undefined;
    const session: RealtimeSession = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      config: {},
      async sendAudio() {},
      async sendMedia() {},
      async sendText() {},
      async sendToolResult() {},
      async update() {},
      eventStream() {
        return (async function* () {
          yield { type: "realtime-start" } as const;
          await new Promise<void>((resolve) => {
            releaseEvents = resolve;
          });
        })();
      },
      async close() {
        closed += 1;
        releaseEvents?.();
      }
    };
    const model: RealtimeModel = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      async connect(_config, options) {
        connectSignal = options?.signal;
        return session;
      }
    };
    const store = createInMemoryAgentRunStore();
    const stream = streamLiveAgent(
      { model, store },
      { runId: "timeout-run", prompt: "wait", timeoutMs: 20 }
    );
    const eventPromise = collectAsync(stream.eventStream);
    const textPromise = collectAsync(stream.textStream);

    await expect(stream.collect()).rejects.toThrow("timed out after 20ms");
    await expect(eventPromise).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: "agent-run-finish" })]));
    await expect(textPromise).resolves.toEqual([]);
    expect(connectSignal?.aborted).toBe(true);
    expect(closed).toBe(1);
    expect(await store.load("timeout-run")).toMatchObject({ status: "timed_out" });
  });

  it("does not let an abandoned saturated event consumer defeat the lifetime timeout", async () => {
    let releaseEvents!: () => void;
    const session: RealtimeSession = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      config: {},
      async sendAudio() {},
      async sendMedia() {},
      async sendText() {},
      async sendToolResult() {},
      async update() {},
      eventStream() {
        return (async function* () {
          for (let index = 0; index < 300; index += 1) {
            yield { type: "realtime-text-delta", textDelta: String(index) } as const;
          }
          await new Promise<void>((resolve) => {
            releaseEvents = resolve;
          });
        })();
      },
      async close() {
        releaseEvents?.();
      }
    };
    const model: RealtimeModel = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      async connect() {
        return session;
      }
    };
    const stream = streamLiveAgent(
      { model },
      { prompt: "fill the queue", timeoutMs: 20 }
    );
    const iterator = stream.eventStream[Symbol.asyncIterator]();
    const collecting = stream.collect();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "agent-run-start" }
    });
    await expect(collecting).rejects.toThrow("timed out after 20ms");

    const remaining: AgentLiveEvent[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    expect(remaining).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error" }),
      expect.objectContaining({ type: "agent-run-finish", status: "timed_out" })
    ]));
  });

  it("leaves a timed-out side effect indeterminate and never sends a tool result", async () => {
    const sentToolResults: ToolExecutionResult[] = [];
    let closed = false;
    const execute = vi.fn(() => new Promise<never>(() => {}));
    const session: RealtimeSession = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      config: {},
      async sendAudio() {},
      async sendMedia() {},
      async sendText() {},
      async sendToolResult(result) {
        sentToolResults.push(result);
      },
      async update() {},
      eventStream() {
        return (async function* () {
          yield { type: "realtime-tool-call", toolCall: { id: "slow-call", name: "slow", input: {} } } as const;
        })();
      },
      async close() {
        closed = true;
      }
    };
    const model: RealtimeModel = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      async connect() {
        return session;
      }
    };
    const store = createInMemoryAgentRunStore();
    const stream = streamLiveAgent(
      {
        model,
        store,
        toolExecution: { timeoutMs: 10 },
        tools: { slow: tool({ name: "slow", schema: z.object({}), execute }) }
      },
      { runId: "indeterminate-tool-run", prompt: "run it" }
    );

    await expect(stream.collect()).rejects.toThrow("Tool execution timed out after 10ms");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sentToolResults).toEqual([]);
    expect(closed).toBe(true);
    expect(await store.listToolCalls!("indeterminate-tool-run")).toMatchObject([
      { toolCallId: "slow-call", status: "running" }
    ]);
  });

  it("fails when a session ends before the response following a tool result", async () => {
    const sentToolResults: ToolExecutionResult[] = [];
    const session: RealtimeSession = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      config: {},
      async sendAudio() {},
      async sendMedia() {},
      async sendText() {},
      async sendToolResult(result) {
        sentToolResults.push(result);
      },
      async update() {},
      eventStream() {
        return (async function* () {
          yield { type: "realtime-tool-call", toolCall: { id: "orphan-call", name: "quick", input: {} } } as const;
          yield { type: "realtime-end", reason: "connection-closed" } as const;
        })();
      },
      async close() {}
    };
    const model: RealtimeModel = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      async connect() {
        return session;
      }
    };
    const store = createInMemoryAgentRunStore();
    const stream = streamLiveAgent(
      {
        model,
        store,
        tools: { quick: tool({ name: "quick", schema: z.object({}), execute: () => ({ ok: true }) }) }
      },
      { runId: "missing-followup-run", prompt: "run it" }
    );

    await expect(stream.collect()).rejects.toThrow("response following a tool result");
    expect(sentToolResults).toHaveLength(1);
    expect(await store.load("missing-followup-run")).toMatchObject({ status: "failed" });
  });

  it("waits for final output transcription when response completion arrives first", async () => {
    let connectedConfig: RealtimeSessionConfig | undefined;
    let iteratorReturned = false;
    const session: RealtimeSession = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      config: {},
      async sendAudio() {},
      async sendMedia() {},
      async sendText() {},
      async sendToolResult() {},
      async update() {},
      eventStream() {
        return (async function* () {
          try {
            yield { type: "realtime-response-complete", reason: "turn-complete" } as const;
            yield {
              type: "realtime-transcript",
              role: "assistant",
              text: "spoken ",
              isFinal: false
            } as const;
            yield {
              type: "realtime-transcript",
              role: "assistant",
              text: "answer",
              isFinal: false
            } as const;
            yield {
              type: "realtime-transcript",
              role: "assistant",
              text: "",
              isFinal: true
            } as const;
            throw new Error("event stream was consumed after both terminal signals");
          } finally {
            iteratorReturned = true;
          }
        })();
      },
      async close() {}
    };
    const model: RealtimeModel = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      async connect(config) {
        connectedConfig = config;
        return session;
      }
    };
    const stream = streamLiveAgent(
      { model },
      { prompt: "speak", realtime: { outputAudioTranscription: true } }
    );

    const result = await stream.collect();

    expect(connectedConfig?.outputAudioTranscription).toBe(true);
    expect(result.outputText).toBe("spoken answer");
    expect(result.status).toBe("completed");
    expect(iteratorReturned).toBe(true);
  });

  it("bounds failure persistence and finish telemetry after a lifetime timeout", async () => {
    const never = new Promise<never>(() => {});
    const finishTelemetry = vi.fn((event: { type: string }) =>
      event.type === "run-finish" ? never : undefined
    );
    const connect = vi.fn(async (): Promise<RealtimeSession> => {
      throw new Error("connect should not run while the initial checkpoint is pending");
    });
    const model: RealtimeModel = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      connect
    };
    const stream = streamLiveAgent(
      {
        model,
        store: {
          load: () => undefined,
          save: () => never
        },
        onTelemetryEvent: finishTelemetry
      },
      { runId: "bounded-failure-cleanup", prompt: "wait", timeoutMs: 20 }
    );
    const events = collectAsync(stream.eventStream);
    const startedAt = Date.now();

    await expect(stream.collect()).rejects.toThrow("timed out after 20ms");
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    await expect(events).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error" }),
      expect.objectContaining({ type: "agent-run-finish", status: "timed_out" })
    ]));
    expect(finishTelemetry).toHaveBeenCalledWith(expect.objectContaining({ type: "run-finish" }));
    expect(connect).not.toHaveBeenCalled();
  });

  it("marks the run failed when closing the realtime session fails", async () => {
    const store = createInMemoryAgentRunStore();
    const close = vi.fn(async () => {
      throw new Error("close failed");
    });
    const session: RealtimeSession = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      config: {},
      async sendAudio() {},
      async sendMedia() {},
      async sendText() {},
      async sendToolResult() {},
      async update() {},
      eventStream() {
        return (async function* () {
          yield { type: "realtime-text-delta", textDelta: "almost done" } as const;
          yield {
            type: "realtime-transcript",
            role: "assistant",
            text: "almost done",
            isFinal: true
          } as const;
          yield { type: "realtime-response-complete", reason: "turn-complete" } as const;
        })();
      },
      close
    };
    const model: RealtimeModel = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      async connect() {
        return session;
      }
    };
    const stream = streamLiveAgent({ model, store }, { runId: "close-failure-run", prompt: "finish" });

    await expect(stream.collect()).rejects.toThrow("close failed");
    expect(close).toHaveBeenCalledTimes(1);
    expect(await store.load("close-failure-run")).toMatchObject({
      status: "failed",
      error: { message: "close failed" }
    });
  });

  it("replays a completed idempotent live run without reconnecting or repeating side effects", async () => {
    const execute = vi.fn(() => ({ ok: true }));
    const connect = vi.fn(async (): Promise<RealtimeSession> => ({
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      config: {},
      async sendAudio() {},
      async sendMedia() {},
      async sendText() {},
      async sendToolResult() {},
      async update() {},
      eventStream() {
        return (async function* () {
          yield { type: "realtime-tool-call", toolCall: { id: "once", name: "once", input: {} } } as const;
          yield { type: "realtime-response-complete", reason: "turn-complete" } as const;
          yield { type: "realtime-text-delta", textDelta: "done" } as const;
          yield { type: "realtime-transcript", role: "assistant", text: "done", isFinal: true } as const;
          yield { type: "realtime-response-complete", reason: "turn-complete" } as const;
        })();
      },
      async close() {}
    }));
    const model: RealtimeModel = {
      provider: "test",
      modelId: "live-model",
      capabilities: liveCapabilities,
      connect
    };
    const store = createInMemoryAgentRunStore();
    const definition = {
      model,
      store,
      tools: { once: tool({ name: "once", schema: z.object({}), execute }) }
    };

    const first = streamLiveAgent(definition, {
      runId: "idempotent-first",
      idempotencyKey: "same-request",
      scope: { tenantId: "tenant-a" },
      prompt: "run"
    });
    const firstResult = await first.collect();
    const replay = streamLiveAgent(definition, {
      runId: "idempotent-second",
      idempotencyKey: "same-request",
      scope: { tenantId: "tenant-a" },
      prompt: "run again"
    });

    await expect(replay.session).rejects.toThrow("replayed from durable state");
    const replayResult = await replay.collect();
    expect(replayResult.state.runId).toBe(firstResult.state.runId);
    expect(replayResult.outputText).toBe("done");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
