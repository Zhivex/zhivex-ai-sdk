/** Opt-in paid smoke: raw mono PCM16/24kHz speech, with no personal data. */
import { createLiveSmokeTransport } from "./lib/openai-live-smoke-transport.js";
import { z } from "zod";
import { randomInt } from "node:crypto";
import { createQwen, type QwenRegion } from "../packages/qwen/src/index.js";
import { readFile, writeFile } from "node:fs/promises";
import { createOpenAI } from "../packages/openai/src/index.js";
import { createAgent, runAgent, tool, user, runRealtimeDelegations, type RealtimeSession } from "../packages/core/src/index.js";

if (process.env.ZHIVEX_OPENAI_LIVE_SMOKE !== "1") throw new Error("Set ZHIVEX_OPENAI_LIVE_SMOKE=1 to enable the paid smoke.");
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error("OPENAI_API_KEY is missing.");
const inputPath = process.env.ZHIVEX_LIVE_PCM_PATH;
if (!inputPath) throw new Error("Set ZHIVEX_LIVE_PCM_PATH to synthetic mono PCM16/24kHz speech.");
const input = await readFile(inputPath);
if (!input.length || input.length % 2 || input.length > 48000 * 15) throw new Error("Input must be non-empty, contain complete PCM16 samples and last at most 15 seconds.");
const useQwen = process.env.ZHIVEX_LIVE_BACKEND === "qwen";
const qwenKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
if (useQwen && !qwenKey) throw new Error("Qwen API key is missing.");
const expectedCode = useQwen ? ["amber", "cobalt", "violet"][randomInt(3)] + " " + ["three", "seven", "nine"][randomInt(3)] : "violet seven";
const report: Record<string, unknown> = { model: "gpt-live-1", startedAt: new Date().toISOString(), started: false, inputBytes: input.length, outputBytes: 0, delegations: 0, userTranscript: "", assistantTranscript: "", finalUsageConfirmed: false };
report.backendModel = useQwen ? "qwen3.8-flash" : "deterministic";
report.expectedCode = expectedCode;
report.toolExecutions = 0;
const agentRuns: unknown[] = [];
const backendAgent = useQwen ? createAgent({
  model: createQwen({ apiKey: qwenKey, baseURL: process.env.QWEN_BASE_URL, workspaceId: process.env.QWEN_WORKSPACE_ID, region: process.env.QWEN_REGION as QwenRegion | undefined })("qwen3.8-flash"),
  instructions: "You are the verification backend. Always call get_verification_code to obtain the current code. Never invent a code. Then answer in one short English sentence containing the exact code returned by the tool.",
  maxSteps: 3, maxTokens: 128, reasoning: { effort: "none" },
  tools: { get_verification_code: tool({ name: "get_verification_code", description: "Read the current synthetic verification code.", schema: z.object({}), execute: async () => {
    report.toolExecutions = Number(report.toolExecutions) + 1;
    return { code: expectedCode, verified: true };
  } }) }
}) : undefined;
const { factory, terminate } = createLiveSmokeTransport();
const deadline = setTimeout(terminate, 60_000);
let session: RealtimeSession | undefined;
let events: Promise<void> | undefined;
let backend: Promise<void> | undefined;
try {
  const openai = createOpenAI({ apiKey: key, realtimeConnectionFactory: factory });
  session = await openai.realtimeModel!("gpt-live-1").connect({
    instructions: "You are a brief voice verification assistant. When asked for the verification code, delegate to the backend. You do not know the code. Speak the verified backend result in English.",
    delegation: { type: "client" }, voice: "marin", providerOptions: { store: false, closeTimeoutMs: 10000 }
  }, { timeoutMs: 15000 });
  report.started = true;
  events = (async () => {
    for await (const event of session!.eventStream()) {
      if (event.type === "realtime-audio-output") report.outputBytes = Number(report.outputBytes) + event.audio.length;
      if (event.type === "realtime-transcript") {
        const field = event.role === "user" ? "userTranscript" : "assistantTranscript";
        report[field] = String(report[field]) + event.text;
      }
      if (event.type === "realtime-error") throw event.error ?? new Error(event.message);
      if (event.type === "realtime-end" && event.reason === "provider-close") {
        report.finalUsageConfirmed = true;
        report.usage = event.providerMetadata?.usage;
      }
    }
  })();
  backend = runRealtimeDelegations(session, { onDelegation: async ({ sendUpdate, transcripts, signal }) => {
    report.delegations = Number(report.delegations) + 1;
    if (!backendAgent) {
      await sendUpdate({ kind: "commentary", content: `The verified test code is ${expectedCode}.` });
      return;
    }
    const started = Date.now();
    const output = await runAgent(backendAgent, {
      messages: [user(JSON.stringify(transcripts))],
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    });
    agentRuns.push({ status: output.status, outputText: output.outputText, steps: output.steps.length, toolResults: output.toolResults.length, usage: output.usage, elapsedMs: Date.now() - started, error: output.error });
    report.agentRuns = agentRuns;
    if (output.status !== "completed" || !output.toolResults.length || !output.outputText.toLowerCase().includes(expectedCode)) throw new Error("Qwen did not complete a verified tool-backed answer.");
    await sendUpdate({ kind: "commentary", content: output.outputText });
  } });
  void events.catch(() => undefined);
  void backend.catch(() => undefined);
  // 20ms chunks preserve real capture timing. Then continue with silence for the reply.
  const start = Date.now();
  for (let offset = 0; Date.now() - start < (useQwen ? 35_000 : 22_000); offset += 960) {
    const chunk = offset < input.length ? input.subarray(offset, offset + 960) : Buffer.alloc(960);
    await session.sendAudio({ data: chunk, mediaType: "audio/pcm", sampleRateHz: 24000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await session.close();
  await Promise.all([events, backend]);
  report.passed = Boolean(report.started && Number(report.outputBytes) > 0 && Number(report.delegations) > 0 && String(report.userTranscript).length && String(report.assistantTranscript).toLowerCase().includes(expectedCode) && (!useQwen || (Number(report.toolExecutions) > 0 && agentRuns.length > 0)) && report.finalUsageConfirmed);
  if (!report.passed) throw new Error("Smoke assertions incomplete; see individual checks.");
} catch (error) {
  report.passed = false;
  const cause = error && typeof error === "object" && "error" in error ? error.error : error;
  report.error = (cause instanceof Error ? cause.message : String(cause)).replaceAll(key, "[REDACTED]").replaceAll(qwenKey ?? "__NO_QWEN_KEY__", "[REDACTED]");
  process.exitCode = 1;
} finally {
  if (session) await session.close().catch(() => undefined);
  terminate();
  await Promise.allSettled([events, backend].filter((p): p is Promise<void> => Boolean(p)));
  clearTimeout(deadline);
  report.finishedAt = new Date().toISOString();
  await writeFile(useQwen ? "/tmp/zhivex-openai-live-qwen-smoke.json" : "/tmp/zhivex-openai-live-smoke.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
