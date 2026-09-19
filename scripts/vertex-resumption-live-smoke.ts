import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { createVertex } from "../packages/vertex/src/index.js";
import type { RealtimeSession } from "../packages/core/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

// Explicit opt-in: two billable Live connections, synthetic context only.
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const provider = createVertex({ ...credentials.options, location: "us-central1" });
const model = provider.realtimeModel!("gemini-live-2.5-flash-native-audio");
const expected = ["violet", "amber", "cobalt"][randomInt(3)] + " " + ["seven", "three", "nine"][randomInt(3)];
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error("Live resumption deadline")), 55_000);
let session: RealtimeSession | undefined;
let handle: string | undefined, completed = false, verified = false;
try {
  session = await model.connect({ outputAudioTranscription: true, providerOptions: { sessionResumption: {} } }, { signal: controller.signal, timeoutMs: 15_000 });
  await session.sendText(`Remember my verification code: ${expected}. Say only OK.`);
  for await (const event of session.eventStream()) {
    if (event.type === "realtime-session-resumption") handle = event.resumable ? event.handle : undefined;
    if (event.type === "realtime-response-complete" && event.reason === "turn-complete") completed = true;
    if (event.type === "realtime-error" || event.type === "realtime-end") throw new Error("Initial session ended unexpectedly");
    if (completed && handle) break;
  }
  assert.ok(completed && handle);
  await session.close();
  session = await model.connect({ outputAudioTranscription: true, providerOptions: { sessionResumption: { handle } } }, { signal: controller.signal, timeoutMs: 15_000 });
  // The second connection receives neither the code nor replayed conversation.
  await session.sendText("What is my verification code? Say only the code.");
  let transcript = "", audioChunks = 0;
  completed = false;
  for await (const event of session.eventStream()) {
    if (event.type === "realtime-transcript" && event.role === "assistant") transcript = event.isFinal ? event.text : transcript + event.text;
    if (event.type === "realtime-audio-output") audioChunks++;
    if (event.type === "realtime-error" || event.type === "realtime-end") throw new Error("Resumed session ended unexpectedly");
    if (event.type === "realtime-response-complete" && event.reason === "turn-complete") { completed = true; break; }
  }
  verified = transcript.toLowerCase().replace(/\s+/g, " ").includes(expected);
  assert.ok(completed && audioChunks > 0 && verified);
  console.log(JSON.stringify({ ok: true, resumed: true, contextVerified: verified, audioChunks }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: (error as Error).name, receivedHandle: Boolean(handle), completed, contextVerified: verified }));
  process.exitCode = 1;
} finally {
  await session?.close();
  clearTimeout(deadline);
  controller.abort();
}
