import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createVertex } from "../packages/vertex/src/index.js";
import type { RealtimeSession } from "../packages/core/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";
import { openAuthenticatedWebSocketConnection } from "../packages/core/src/realtime-node.js";
import type { RealtimeConnectionFactory } from "../packages/core/src/realtime.js";

// Opt-in through explicit invocation. One synthetic turn, bounded to 45s.
const withTools = process.argv.includes("--tools");
const withImage = process.argv.includes("--image");
const withTranslation = process.argv.includes("--translate");
const withAudio = process.argv.includes("--audio") || withTranslation;
const withUpdate = process.argv.includes("--update");
if (withImage && (withTools || withAudio || withUpdate)) throw new Error("Use --image separately");
if (withUpdate && (withTools || withAudio)) throw new Error("Use --update separately");
if (withTools && withAudio) throw new Error("Choose either --tools or --audio");
const expected = withTools ? ["violet", "amber", "cobalt"][randomInt(3)] + " " + ["seven", "three", "nine"][randomInt(3)] : withImage ? "42" : withTranslation ? "hola mundo" : "hello world";
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error("Vertex Live smoke deadline")), 45_000);
let session: RealtimeSession | undefined;
let audioChunks = 0, completed = false, transcript = "", inputTranscript = "", toolCalls = 0;
const wireShapes = new Set<string>();
const diagnosticConnection: RealtimeConnectionFactory = async (...args) => {
  const connection = await openAuthenticatedWebSocketConnection(...args);
  return {
    ...connection,
    async recvJson() {
      const value = await connection.recvJson();
      if (value && typeof value === "object") {
        const frame = value as Record<string, unknown>;
        const content = (frame.serverContent ?? frame.server_content ?? {}) as Record<string, unknown>;
        const turn = (content.modelTurn ?? content.model_turn ?? {}) as Record<string, unknown>;
        const shape = JSON.stringify({ fields: Object.keys(frame), content: Object.keys(content), parts: Array.isArray(turn.parts) ? turn.parts.map(part => Object.keys(part ?? {})) : [] });
        if (!wireShapes.has(shape) && wireShapes.size < 20) { wireShapes.add(shape); console.error(shape); }
      }
      return value;
    }
  };
};
try {
  const modelId = process.env.VERTEX_LIVE_MODEL ?? (withTranslation ? "gemini-3.5-live-translate-preview" : "gemini-live-2.5-flash-native-audio");
  const provider = createVertex({ ...credentials.options, ...(process.env.VERTEX_LIVE_DIAGNOSTICS === "1" ? { realtimeConnectionFactory: diagnosticConnection } : {}), apiVersion: process.env.VERTEX_LIVE_API_VERSION ?? "v1", location: process.env.VERTEX_LIVE_LOCATION ?? (withTranslation ? "global" : "us-central1") });
  session = await provider.realtimeModel!(modelId).connect({ ...(withTranslation ? { mode: "translation", translation: { targetLanguage: "es" } } as const : {}), outputAudioTranscription: true, ...(withAudio ? { inputAudioTranscription: true } : {}), ...(withTools ? { tools: { get_verification_code: { name: "get_verification_code", description: "Return the verification code to say aloud.", schema: z.object({}) } } } : {}) }, { timeoutMs: 15_000, signal: controller.signal });
  if (withImage) {
    await session.sendMedia({ data: await readFile(new URL("../packages/vertex/tests/fixtures/ocr-invoice.png", import.meta.url)), mediaType: "image/png" });
    await delay(1000, undefined, { signal: controller.signal });
    await session.sendText("Read the invoice total in the image. Say only the number using digits in your transcription.");
  } else if (withUpdate) {
    await session.update({ instructions: "For every user message, reply with exactly: hello world." });
    await session.sendText("What is two plus two?");
  } else if (withAudio) {
    const speech = await readFile(new URL("../packages/vertex/tests/fixtures/live-hello-world.pcm", import.meta.url));
    // Signed 16-bit little-endian mono PCM, 16 kHz; trailing silence triggers VAD.
    const pcm = Buffer.concat([speech, Buffer.alloc(32_000)]);
    for (let offset = 0; offset < pcm.length; offset += 3_200) {
      await session.sendAudio({ data: pcm.subarray(offset, offset + 3_200), mediaType: "audio/pcm;rate=16000" });
      await delay(100, undefined, { signal: controller.signal });
    }
    if (withTranslation) await session.setInputMuted(true);
  } else {
    await session.sendText(withTools ? "Call get_verification_code, then say only the returned code." : "Say exactly: hello world.");
  }
  for await (const event of session.eventStream()) {
    if (withTranslation && process.env.VERTEX_LIVE_DIAGNOSTICS === "1" && event.type === "realtime-transcript") {
      console.error(JSON.stringify({ role: event.role, text: event.text.slice(0, 200), isFinal: event.isFinal }));
    }
    if (withTranslation && process.env.VERTEX_LIVE_DIAGNOSTICS === "1" && event.type === "realtime-text-delta") {
      console.error(JSON.stringify({ textDelta: event.textDelta.slice(0, 500) }));
    }
    // This fixed synthetic probe expects a translation, not a quota message.
    // Keep this diagnostic in the smoke: arbitrary model text is not an SDK error contract.
    if (withTranslation && event.type === "realtime-text-delta" && event.textDelta.trim() === "Quota exceeded. Please retry later.") {
      throw new Error("Vertex Live Translate returned a quota-exceeded message instead of the synthetic translation.");
    }
    if (event.type === "realtime-tool-call") {
      assert.ok(withTools);
      assert.equal(event.toolCall.name, "get_verification_code");
      assert.equal(++toolCalls, 1);
      await session.sendToolResult({ toolCallId: event.toolCall.id, toolName: event.toolCall.name, output: { code: expected }, isError: false });
    }
    if (event.type === "realtime-audio-output") audioChunks++;
    if (event.type === "realtime-transcript" && event.role === "assistant") transcript += event.text;
    if (event.type === "realtime-transcript" && event.role === "user") inputTranscript += event.text;
    if (event.type === "realtime-error") throw event.error ?? new Error(event.message ?? "Vertex emitted a realtime error");
    if (event.type === "realtime-response-complete" && event.reason === "turn-complete" && (!withTools || (toolCalls === 1 && audioChunks > 0))) { completed = true; break; }
  }
  assert.ok(completed && audioChunks > 0);
  assert.ok(transcript.toLowerCase().replace(/\s+/g, " ").includes(expected));
  assert.equal(toolCalls, withTools ? 1 : 0);
  if (withAudio) assert.ok(inputTranscript.toLowerCase().includes("hello world"));
  console.log(JSON.stringify({ ok: true, modelId, completed, audioChunks, toolCalls, transcriptVerified: true, ...(withAudio ? { inputTranscriptVerified: true } : {}) }));
} catch (error) {
  if (process.env.VERTEX_LIVE_DIAGNOSTICS === "1") console.error(String((error as Error).message).replace(/Bearer\s+\S+/gi, "Bearer [redacted]"));
  console.log(JSON.stringify({ ok: false, error: (error as Error).name, completed, audioChunks, toolCalls, transcriptVerified: transcript.toLowerCase().replace(/\s+/g, " ").includes(expected), ...(withAudio ? { inputTranscriptVerified: inputTranscript.toLowerCase().includes("hello world") } : {}) }));
  process.exitCode = 1;
} finally {
  await session?.close();
  clearTimeout(deadline);
  controller.abort();
}
