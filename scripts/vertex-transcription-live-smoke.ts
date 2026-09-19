import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

// One bounded call using repository-owned synthetic speech, never user audio.
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const pcm = readFileSync(new URL("../packages/vertex/tests/fixtures/live-hello-world.pcm", import.meta.url));
const wav = Buffer.alloc(44 + pcm.length);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
const apiVersion = process.env.VERTEX_TRANSCRIPTION_API_VERSION === "v1beta1" ? "v1beta1" : "v1";
try {
  const vertex = createVertex({ ...credentials.options, location: "global", apiVersion });
  const result = await vertex.transcriptionModel("gemini-3.5-transcribe-preview").transcribe({ audio: { data: wav, mediaType: "audio/wav" }, language: "en-US", providerOptions: { audioTranscriptionConfig: { wordTimestamp: true } }, timeoutMs: 45000, maxRetries: 0 });
  assert.match(result.text, /hello\s+world/i);
  assert.ok(result.transcriptions.some(part => part.words?.some(word => word.startOffset !== undefined && word.endOffset !== undefined)), "Expected word timestamps");
  console.log(JSON.stringify({ ok: true, apiVersion, model: "gemini-3.5-transcribe-preview", parts: result.transcriptions.length }));
} catch (error) {
  const e = error as { name?: string; status?: number; responseBody?: unknown };
  console.log(JSON.stringify({ ok: false, apiVersion, error: e.name, status: e.status }));
  process.exitCode = 1;
}
