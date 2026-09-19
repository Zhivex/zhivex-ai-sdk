import assert from "node:assert/strict";
import { createVertex } from "../packages/vertex/src/index.js";
import type { RealtimeSession } from "../packages/core/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 45_000);
let session: RealtimeSession | undefined;
let requested = false, interrupted = false, followup = false, completed = false;
let transcript = "", audioChunks = 0;
try {
  session = await createVertex({ ...credentials.options, location: "us-central1" })
    .realtimeModel!("gemini-live-2.5-flash-native-audio").connect({ outputAudioTranscription: true, providerOptions: { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } }, { signal: controller.signal, timeoutMs: 15_000 });
  await session.sendText("Count slowly from one to one hundred, without skipping any numbers.");
  for await (const event of session.eventStream()) {
    if (event.type === "realtime-error") throw event.error ?? new Error("Live error");
    if (event.type === "realtime-audio-output") {
      if (!requested) { requested = true; await session.interrupt!(); }
      else if (followup) audioChunks++;
    }
    if (event.type === "realtime-response-complete" && event.reason === "interrupted") interrupted = true;
    if (followup && event.type === "realtime-transcript" && event.role === "assistant") transcript = event.isFinal ? event.text : transcript + event.text;
    if (event.type === "realtime-response-complete" && event.reason === "turn-complete") {
      if (!followup) {
        assert.ok(interrupted, "Expected a server interruption before the first turn completed");
        followup = true;
        await session.sendText("Say exactly: hello world.");
      } else { completed = true; break; }
    }
  }
  assert.ok(requested && interrupted && completed && audioChunks > 0 && transcript.toLowerCase().includes("hello world"));
  console.log(JSON.stringify({ ok: true, interrupted, completed, followupAudioChunks: audioChunks }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: (error as Error).name, requested, interrupted, completed }));
  process.exitCode = 1;
} finally { await session?.close(); clearTimeout(deadline); controller.abort(); }
