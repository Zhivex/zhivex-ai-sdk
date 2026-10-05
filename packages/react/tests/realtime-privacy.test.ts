import { describe, expect, it } from "vitest";
import type { AgentLiveEvent, RealtimeSession } from "@zhivex-ai/core";
import { OpenAIRealtimeModel } from "../../openai/src/realtime.js";
import { createRealtimeRelay } from "../src/realtime-server.js";
import { decodeRealtimeBase64, decodeRealtimeEvent, encodeRealtimeEvent, realtimeBase64 } from "../src/realtime-codec.js";

const secret = "server-only-customer-123";
const browserEvent = (value: unknown) => encodeRealtimeEvent(value as AgentLiveEvent);

describe("realtime relay privacy", () => {
  it("does not forward tool arguments from the real OpenAI adapter's response.done metadata", async () => {
    const payload = { type: "response.done", response: { output: [{
      type: "function_call", name: "lookup_internal", arguments: JSON.stringify({ internalCustomerId: secret })
    }] } };
    let received = false;
    const model = new OpenAIRealtimeModel("gpt-realtime", "test-key-not-used", "https://api.openai.com/v1", globalThis.fetch, async () => ({
      sendJson: async () => {},
      recvJson: async () => { if (received) return null; received = true; return payload; },
      close: async () => {}
    }));
    const session = await model.connect();
    const sent: string[] = [];
    const relay = createRealtimeRelay({ session, send: data => { sent.push(data); }, close() {} });
    await relay.done;

    const completed = sent.map(data => JSON.parse(data)).find(frame => frame.event?.type === "realtime-response-complete");
    expect(completed).toEqual({ type: "event", event: { type: "realtime-response-complete" } });
    expect(sent.join("\n")).not.toContain(secret);
    expect(sent.join("\n")).not.toContain("providerMetadata");
  });

  it.each([
    { type: "realtime-start", sessionId: "session-1" },
    { type: "realtime-end", reason: "connection-closed" },
    { type: "realtime-response-complete", reason: "completed" },
    { type: "realtime-text-delta", textDelta: "Hello", itemId: "item-1", responseId: "response-1", role: "assistant" },
    { type: "realtime-transcript", text: "Hello", role: "user", isFinal: false, startMs: 0, endMs: 100, itemId: "item-1", responseId: "response-1" },
    { type: "realtime-delegation", delegationId: "delegation-1", offsetMs: 0 }
  ])("preserves the public fields of $type while dropping metadata and extra properties", event => {
    expect(browserEvent({ ...event, providerMetadata: { nested: { secret } }, instructions: secret })).toEqual(event);
  });

  it("encodes audio without forwarding the original provider payload", () => {
    const audio = new Uint8Array([0, 128, 255, 127]);
    const event = { type: "realtime-audio-output", audio, mediaType: "audio/pcm", sampleRateHz: 24000, channels: 1, itemId: "item-1", responseId: "response-1" };
    const encoded = browserEvent({ ...event, providerMetadata: { delta: secret }, privateContext: secret });
    expect(encoded).toEqual({ ...event, audio: "AID/fw==" });
    expect(decodeRealtimeEvent(encoded)).toEqual(event);
  });

  it("projects nested execution summaries and delegation events before sending to the browser", async () => {
    const run = {
      runId: "run-1", parentRunId: "parent-1", agentId: "agent-1", name: "Research", status: "running",
      provider: "openai", modelId: "gpt-realtime", currentStep: 1, maxSteps: 4, toolCalls: 1,
      handoffToAgentId: "agent-2", startedAt: 1, updatedAt: 2,
      usage: { inputTokens: 10, cachedInputTokens: 2, cacheWriteTokens: 1, outputTokens: 3, reasoningTokens: 1, totalTokens: 13, speed: "fast" },
      budget: { maxTotalTokens: 100, maxToolCalls: 5 }
    };
    const events = [
      { type: "agent-run-update", providerMetadata: { secret }, run: { ...run,
        messages: [{ role: "system", content: secret }], scope: { tenantId: secret },
        usage: { ...run.usage, providerMetadata: { secret } }, budget: { ...run.budget, credentials: { secret } }
      } },
      { type: "realtime-delegation", delegationId: "delegation-1", offsetMs: 0, providerMetadata: { arguments: { secret } }, task: { instructions: secret } }
    ];
    const sent: string[] = [];
    const session = { close: async () => {}, eventStream: async function* () { yield* events; } } as unknown as RealtimeSession;
    const relay = createRealtimeRelay({ session, send: data => { sent.push(data); }, close() {} });
    await relay.done;
    expect(sent.map(data => JSON.parse(data))).toEqual([
      { type: "ready" },
      { type: "event", event: { type: "agent-run-update", run } },
      { type: "event", event: { type: "realtime-delegation", delegationId: "delegation-1", offsetMs: 0 } }
    ]);
    expect(sent.join("\n")).not.toContain(secret);
  });

  it("does not serialize objects smuggled into scalar fields or custom toJSON methods", () => {
    expect(browserEvent({ type: "realtime-start", sessionId: { toJSON: () => secret }, toJSON: () => ({ secret }) })).toEqual({ type: "realtime-start" });
    expect(browserEvent({ type: "agent-run-update", run: { runId: "run-1", status: "running", currentStep: 0, maxSteps: 1, usage: { totalTokens: Infinity } } })).toEqual({
      type: "agent-run-update", run: { runId: "run-1", status: "running", currentStep: 0, maxSteps: 1, usage: {} }
    });
  });

  it.each(["error", "realtime-error"])("sanitizes %s diagnostics", type => {
    expect(browserEvent({ type, message: secret, error: { message: secret }, providerMetadata: { secret } })).toEqual({
      type: "realtime-error", message: "Realtime provider failed."
    });
  });

  it("rejects event families that have no browser projection", () => {
    expect(() => browserEvent({ type: "realtime-provider-data", provider: "openai", data: { secret } })).toThrow("Unsupported browser realtime event");
  });
});

describe("realtime frame codec", () => {
  it("round-trips binary views and buffers within the media bound", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect([...decodeRealtimeBase64(realtimeBase64(bytes.subarray(1, 3)))]).toEqual([2, 3]);
    expect([...decodeRealtimeBase64(realtimeBase64(bytes.buffer))]).toEqual([...bytes]);
    expect(() => realtimeBase64(new Uint8Array(256 * 1024 + 1))).toThrow("exceeds 256 KiB");
    expect(() => decodeRealtimeBase64("A".repeat(350_001))).toThrow("Invalid realtime base64 frame");
    expect(() => decodeRealtimeBase64("not base64!")).toThrow("Invalid realtime base64 frame");
  });

  it.each([null, {}, { type: 1 }, { type: "realtime-audio-output", audio: 123, mediaType: "audio/pcm" },
    { type: "realtime-text-delta", textDelta: 1 },
    { type: "realtime-transcript", text: "hello", role: "system", isFinal: true }])("rejects malformed incoming frames: %j", frame => {
    expect(() => decodeRealtimeEvent(frame)).toThrow("Malformed");
  });

  it("decodes valid text and transcript frames", () => {
    const delta = { type: "realtime-text-delta", textDelta: "hello" };
    const transcript = { type: "realtime-transcript", text: "hello", role: "assistant", isFinal: true };
    expect(decodeRealtimeEvent(delta)).toEqual(delta);
    expect(decodeRealtimeEvent(transcript)).toEqual(transcript);
  });
});
