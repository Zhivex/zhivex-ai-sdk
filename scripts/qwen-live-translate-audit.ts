/** Opt-in live audit. Reads only explicitly selected synthetic fixtures; never prints credentials. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createQwen, type QwenRegion } from "../packages/qwen/src/index.js";
const targetLanguage = process.env.QWEN_LIVETRANSLATE_TARGET_LANGUAGE ?? "es";
const modelId = "qwen3.8-livetranslate-flash-realtime";
const file = process.env.QWEN_LIVETRANSLATE_PCM_FILE;
if (!file) throw new Error("Set QWEN_LIVETRANSLATE_PCM_FILE to a synthetic mono 16 kHz PCM16LE fixture.");
const pcm = await readFile(file);
if (!pcm.length || pcm.length % 2 || pcm.length > 960000) throw new Error("Use 1-30 seconds of PCM16LE audio.");
const dir = resolve(process.env.QWEN_LIVETRANSLATE_AUDIT_DIR ?? ".release/qwen-live-translate-audit");
await mkdir(dir, { recursive: true });
const provider = createQwen({ workspaceId: process.env.QWEN_WORKSPACE_ID, region: process.env.QWEN_REGION as QwenRegion | undefined, realtimeURL: process.env.QWEN_REALTIME_URL });
function wav(bytes: Buffer, rate: number) {
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(bytes.length + 36, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
}
const stats = (bytes: Buffer, rate: number) => {
  let squares = 0, peak = 0, clipped = 0;
  for (let i = 0; i < bytes.length; i += 2) { const x = bytes.readInt16LE(i) / 32768; squares += x * x; peak = Math.max(peak, Math.abs(x)); if (Math.abs(x) >= 0.999) clipped++; }
  return { seconds: bytes.length / (rate * 2), rms: Math.sqrt(squares / (bytes.length / 2)), peak, clippedFraction: clipped / (bytes.length / 2) };
};
await writeFile(resolve(dir, "source.wav"), wav(pcm, 16000));
const report: Record<string, unknown> = { modelId, recordedAt: new Date().toISOString(), targetLanguage, syntheticFixture: true, source: stats(pcm, 16000), perceptualSimilarity: "not evaluated; audio review required", runs: [] };
const runs = report.runs as Record<string, unknown>[];
let createdVoice: string | undefined;
let failure: unknown;
try {
  // This explicit flag creates a persistent remote resource. Do not set without authorization.
  if (process.env.QWEN_LIVETRANSLATE_ENROLL === "1") {
    const voice = await provider.voices.create({ targetModel: modelId, preferredName: `zhx${Date.now()}`, language: "en", audio: `data:audio/wav;base64,${wav(pcm, 16000).toString("base64")}` });
    createdVoice = voice.voice;
    await writeFile(resolve(dir, "created-voice.json"), JSON.stringify({ voice: createdVoice, targetModel: voice.targetModel }), { mode: 0o600 });
    report.enrollment = { created: true, targetModel: voice.targetModel, fallbackMode: voice.fallbackMode };
    if (voice.targetModel !== modelId || voice.fallbackMode === true) throw new Error("Enrollment did not confirm the exact target model without degraded fallback.");
  }
  const modes = process.env.QWEN_LIVETRANSLATE_AUDIT_MODES?.split(",") ?? (createdVoice ? ["baseline", "once", "always", "never"] : ["baseline", "once", "always"]);
  if (!modes.length || modes.some(mode => !["baseline", "once", "always", "never"].includes(mode)) || (modes.includes("never") && !createdVoice)) throw new Error("Invalid audit modes; never requires enrollment.");
  for (const mode of modes) {
    const session = await provider.realtimeModel!(modelId).connect({ mode: "translation", translation: { targetLanguage }, outputAudioMediaType: "audio/pcm",
      voice: mode === "baseline" ? "Tina" : mode === "never" ? createdVoice : "default",
      ...(mode === "baseline" ? {} : { providerOptions: { enable_voice_clone: true, voice_clone_options: { frequency: mode } } })
    }, { timeoutMs: 60000 });
    const chunks: Buffer[] = []; const source: string[] = []; const translated: string[] = []; const errors: string[] = [];
    let endReason: string | undefined;
    let finished = false, cloneAcknowledged = mode === "baseline";
    const receiving = (async () => { for await (const event of session.eventStream()) {
      if (event.type === "realtime-audio-output") chunks.push(Buffer.from(event.audio));
      if (event.type === "realtime-transcript" && event.isFinal) (event.role === "user" ? source : translated).push(event.text);
      if (event.type === "realtime-error") errors.push(event.message);
      if (event.type === "realtime-end") { endReason = event.reason; finished = event.reason === "finished"; }
      if (event.type === "realtime-provider-data") { const data = event.data as any; if (data.type === "session.updated" && data.session?.enable_voice_clone === true && data.session?.voice_clone_options?.frequency === mode && (mode !== "never" || data.session?.audio?.output?.voice === createdVoice)) cloneAcknowledged = true; }
    } })();
    let sendFailure: unknown;
    try { for (let offset = 0; offset < pcm.length; offset += 3200) {
      await session.sendAudio({ data: pcm.subarray(offset, offset + 3200), mediaType: "audio/pcm", sampleRateHz: 16000, channels: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));
    } } catch (error) { sendFailure = error; } finally { await session.close(); await receiving; }
    const audio = Buffer.concat(chunks);
    if (audio.length) await writeFile(resolve(dir, `${mode}.wav`), wav(audio, 24000));
    const passed = !sendFailure && !errors.length && finished && cloneAcknowledged && audio.length > 0 && source.length > 0 && translated.length > 0;
    runs.push({ mode, passed, finished, endReason, errorCount: errors.length, sendFailed: !!sendFailure, cloneAcknowledged, source, translated, audio: audio.length ? stats(audio, 24000) : null });
    if (!passed) throw new Error(`Live audit failed for ${mode}; inspect report and provider availability.`);
  }
} catch (error) { failure = error; report.failed = true; }
finally {
  if (createdVoice) {
    try { await provider.voices.delete({ voice: createdVoice }); report.cleanup = { deleted: true }; }
    catch { report.cleanup = { deleted: false, recoveryFile: "created-voice.json" }; failure ??= new Error("Temporary voice cleanup failed; use created-voice.json to delete it."); }
  }
  await writeFile(resolve(dir, "report.json"), JSON.stringify(report, null, 2));
  const files = ["source", ...runs.map(run => String(run.mode))];
  await writeFile(resolve(dir, "review.html"), `<!doctype html><html lang="es"><meta charset="utf-8"><title>Qwen: comparación de voz sintética</title><style>body{font:18px system-ui;max-width:850px;margin:50px auto;background:#10151d;color:#e7edf5}section{padding:18px;border-bottom:1px solid #394452}audio{width:100%}p{line-height:1.5}</style><h1>Comparación de voz sintética</h1><p>Fuente en inglés; el idioma de salida figura en report.json. Comparar timbre, naturalidad, inteligibilidad y conservación de identidad contra la voz base. La aceptación del protocolo y las métricas de señal no certifican similitud perceptual.</p>${files.map(name => `<section><h2>${name}</h2><audio controls src="${name}.wav"></audio></section>`).join("")}<p>Resultados técnicos: <a href="report.json">report.json</a>. Ninguna puntuación subjetiva ha sido inventada.</p></html>`);
}
if (failure) throw failure;
console.log(JSON.stringify({ report: resolve(dir, "report.json"), review: resolve(dir, "review.html"), passed: runs.every(run => run.passed) }));
