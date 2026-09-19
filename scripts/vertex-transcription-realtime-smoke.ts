import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createVertex } from "../packages/vertex/src/index.js";
import type { RealtimeSession } from "@zhivex-ai/core";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error("Transcription smoke deadline")), 45000);
let session: RealtimeSession | undefined;
let interim = 0, finals = 0, audioOutputs = 0, text = "";
try {
  const vertex = createVertex({ ...credentials.options, location: "global", apiVersion: "v1" });
  session = await vertex.realtimeModel!("gemini-3.5-transcribe-live-preview").connect({ mode: "transcription", inputAudioTranscription: { languageCodes: ["en-US"] } }, { signal: controller.signal, timeoutMs: 15000 });
  const pcm = readFileSync(new URL("../packages/vertex/tests/fixtures/live-hello-world.pcm", import.meta.url));
  for (let offset = 0; offset < pcm.length; offset += 3200) {
    await session.sendAudio({ data: pcm.subarray(offset, offset + 3200), mediaType: "audio/pcm;rate=16000" });
    await delay(100, undefined, { signal: controller.signal });
  }
  await session.setInputMuted(true);
  for await (const event of session.eventStream()) {
    if (event.type === "realtime-provider-data" && event.data && typeof event.data === "object" && !Array.isArray(event.data) && event.data.type === "vertex_transcription_interim") interim++;
    if (event.type === "realtime-audio-output") audioOutputs++;
    if (event.type === "realtime-error") throw event.error ?? new Error(event.message);
    if (event.type === "realtime-transcript" && event.role === "user" && event.isFinal) {
      finals++; text += event.text;
      if (/hello\s+world/i.test(text)) break;
    }
  }
  assert.match(text, /hello\s+world/i);
  assert.equal(audioOutputs, 0);
  console.log(JSON.stringify({ ok: true, model: "gemini-3.5-transcribe-live-preview", interim, finals, audioOutputs }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: (error as Error).name, interim, finals, audioOutputs }));
  if (process.env.VERTEX_LIVE_DIAGNOSTICS === "1") console.error(String((error as Error).message).slice(0, 512).replace(/Bearer\s+\S+/gi, "Bearer [redacted]"));
  process.exitCode = 1;
} finally {
  await session?.close(); clearTimeout(deadline); controller.abort();
}
