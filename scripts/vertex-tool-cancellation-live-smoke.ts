import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createVertex } from "../packages/vertex/src/index.js";
import type { RealtimeSession } from "../packages/core/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

// Explicit invocation only: one synthetic pending tool and a follow-up, at most 45s.
const withAudio = process.argv.includes("--audio");
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 45_000);
let session: RealtimeSession | undefined;
let callId: string | undefined;
let callSignal: AbortSignal | undefined;
let cancelled = false, lateResultRejected = false, completed = false;
let transcript = "", audioChunks = 0;
try {
  session = await createVertex({ ...credentials.options, location: "us-central1" })
    .realtimeModel!("gemini-live-2.5-flash-native-audio").connect({
      outputAudioTranscription: true,
      tools: { slow_lookup: { name: "slow_lookup", description: "Look up a verification code. Wait for the tool result before answering.", schema: z.object({}) } },
      ...(withAudio ? {} : { providerOptions: { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } })
    }, { signal: controller.signal, timeoutMs: 15_000 });
  await session.sendText("Call slow_lookup now to get my verification code.");
  for await (const event of session.eventStream()) {
    if (event.type === "realtime-error") throw event.error ?? new Error("Live error");
    if (event.type === "realtime-tool-call") {
      assert.equal(callId, undefined, "Expected only one tool call");
      assert.equal(event.toolCall.name, "slow_lookup");
      callId = event.toolCall.id;
      callSignal = session.toolCallSignal!(callId);
      if (withAudio) {
        const speech = await readFile(new URL("../packages/vertex/tests/fixtures/live-hello-world.pcm", import.meta.url));
        const pcm = Buffer.concat([speech, Buffer.alloc(32_000)]);
        for (let offset = 0; offset < pcm.length; offset += 3_200) {
          await session.sendAudio({ data: pcm.subarray(offset, offset + 3_200), mediaType: "audio/pcm;rate=16000" });
          await delay(100, undefined, { signal: controller.signal });
        }
      } else await session.interrupt!();
    }
    if (event.type === "realtime-tool-call-cancellation") {
      assert.ok(callId && event.toolCallIds.includes(callId), "Cancellation must identify the pending call");
      assert.equal(callSignal?.aborted, true);
      cancelled = true;
      await assert.rejects(session.sendToolResult({ toolCallId: callId, toolName: "slow_lookup", output: "unused" }), /cancelled by the provider/);
      lateResultRejected = true;
      await session.sendText("Forget the lookup. Do not call any tools. Say exactly: hello world.");
    }
    if (cancelled && event.type === "realtime-audio-output") audioChunks++;
    if (cancelled && event.type === "realtime-transcript" && event.role === "assistant") transcript = event.isFinal ? event.text : transcript + event.text;
    if (cancelled && audioChunks > 0 && event.type === "realtime-response-complete" && event.reason === "turn-complete") { completed = true; break; }
  }
  assert.ok(cancelled && lateResultRejected && completed && transcript.toLowerCase().includes("hello world"));
  console.log(JSON.stringify({ ok: true, cancelled, lateResultRejected, completed, audioChunks }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: (error as Error).name, toolCallObserved: !!callId, cancelled, lateResultRejected, completed, audioChunks }));
  process.exitCode = 1;
} finally { await session?.close(); clearTimeout(deadline); controller.abort(); }
