/** Paid opt-in fault injection against GPT-Live and a real Qwen agent. */
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createOpenAI } from "../packages/openai/src/index.js";
import { createQwen, type QwenRegion } from "../packages/qwen/src/index.js";
import { createAgent, runAgent, runRealtimeDelegations, tool, user, type RealtimeDelegationContext, type RealtimeSession } from "../packages/core/src/index.js";
import { createLiveSmokeTransport } from "./lib/openai-live-smoke-transport.js";

if (process.env.ZHIVEX_OPENAI_LIVE_SMOKE !== "1") throw new Error("Paid smoke requires ZHIVEX_OPENAI_LIVE_SMOKE=1.");
const scenario = process.argv[2];
if (scenario !== "interruption" && scenario !== "disconnect") throw new Error("Choose interruption or disconnect.");
const openaiKey = process.env.OPENAI_API_KEY;
const qwenKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
if (!openaiKey || !qwenKey) throw new Error("OpenAI and Qwen credentials are required.");
async function pcm(path: string | undefined) {
  if (!path) throw new Error("Synthetic PCM path is required.");
  const data = await readFile(path);
  if (!data.length || data.length % 2 || data.length > 15 * 48000) throw new Error("Expected 1–15 seconds of mono PCM16/24kHz.");
  return data;
}
const input = await pcm(process.env.ZHIVEX_LIVE_PCM_PATH);
const cancel = scenario === "interruption" ? await pcm(process.env.ZHIVEX_LIVE_CANCEL_PCM_PATH) : undefined;
const report: Record<string, unknown> = { scenario, model: "gpt-live-1", backendModel: "qwen3.8-flash", startedAt: new Date().toISOString(), toolExecutions: 0, userTranscript: "", assistantTranscript: "", outputBytes: 0, finalUsageConfirmed: false };
const { factory, terminate } = createLiveSmokeTransport();
const deadline = setTimeout(terminate, 60_000);
const controller = new AbortController();
const timeline: unknown[] = [];
let revision = 0;
let toolStarted = false;
let backendPending = false;
let injectedAt = 0;
let context: RealtimeDelegationContext | undefined;
let session: RealtimeSession | undefined;
let events: Promise<void> | undefined;
let bridge: Promise<void> | undefined;
let bridgeError: unknown;
let eventError: unknown;
let bridgeSettledAt = 0;
const agentRuns: unknown[] = [];
const pendingAgents: Promise<unknown>[] = [];
const expectedCode = "cobalt three"; // This value is disclosed to Qwen only by the tool.
const agent = createAgent({
  model: createQwen({ apiKey: qwenKey, baseURL: process.env.QWEN_BASE_URL, workspaceId: process.env.QWEN_WORKSPACE_ID, region: process.env.QWEN_REGION as QwenRegion | undefined })("qwen3.8-flash"),
  instructions: "Obtain the verification code with get_verification_code. Never invent it. Then return one short sentence with the exact code.",
  maxSteps: 3, maxTokens: 128, reasoning: { effort: "none" },
  tools: { get_verification_code: tool({ name: "get_verification_code", description: "Read the synthetic verification code.", schema: z.object({}), execute: async () => {
    report.toolExecutions = Number(report.toolExecutions) + 1;
    toolStarted = true;
    timeline.push({ event: "tool-start", at: Date.now() });
    // Deliberately slow, read-only work. It ignores cancellation to test late results.
    await delay(8_000);
    return { code: expectedCode, verified: true };
  } }) }
});
try {
  session = await createOpenAI({ apiKey: openaiKey, realtimeConnectionFactory: factory }).realtimeModel!("gpt-live-1").connect({
    instructions: "When asked for the verification code, briefly say you are checking and delegate to the backend. You do not know the code. Honor a spoken cancellation, acknowledge it briefly, and do not disclose cancelled results.",
    delegation: { type: "client" }, voice: "marin", providerOptions: { store: false, closeTimeoutMs: 15000 }
  }, { timeoutMs: 15000 });
  report.started = true;
  events = (async () => {
    for await (const event of session!.eventStream()) {
      if (event.type === "realtime-audio-output") report.outputBytes = Number(report.outputBytes) + event.audio.length;
      if (event.type === "realtime-transcript") {
        const field = event.role === "user" ? "userTranscript" : "assistantTranscript";
        report[field] = String(report[field]) + event.text;
        timeline.push({ event: "transcript", role: event.role, text: event.text, startMs: event.startMs, endMs: event.endMs, at: Date.now() });
        // Explicit application policy for this synthetic cancellation task.
        // Speech interruptions alone must not imply cancellation of durable work.
        if (event.role === "user" && !revision && /cancel/i.test(String(report.userTranscript))) {
          revision++;
          report.cancellationObservedWhileBackendPending = backendPending;
          report.bridgeSignalAbortedOnSpeech = context?.signal.aborted;
        }
      }
      if (event.type === "realtime-error") throw event.error ?? new Error(event.message);
      if (event.type === "realtime-end" && event.reason === "provider-close") {
        report.finalUsageConfirmed = true;
        report.usage = event.providerMetadata?.usage;
      }
    }
  })().catch((error) => { eventError = error; });
  bridge = runRealtimeDelegations(session, { signal: controller.signal, onDelegation: async (c) => {
    context = c;
    if (revision) {
      await c.sendUpdate({ kind: "commentary", content: "The request is cancelled. Do not disclose a verification code." });
      return;
    }
    const taskRevision = revision;
    backendPending = true;
    const pending = runAgent(agent, { messages: [user(JSON.stringify(c.transcripts))], abortSignal: AbortSignal.any([c.signal, AbortSignal.timeout(20000)]) });
    pendingAgents.push(pending);
    const output = await pending;
    backendPending = false;
    agentRuns.push({ status: output.status, steps: output.steps.length, toolResults: output.toolResults.length, usage: output.usage });
    if (scenario === "interruption") {
      if (output.status !== "completed" || !output.toolResults.length) throw new Error("Real Qwen tool loop did not complete.");
      if (taskRevision !== revision) {
        report.staleResultSuppressed = true;
        await c.sendUpdate({ kind: "commentary", content: "The request is cancelled. Do not disclose a verification code." });
      } else throw new Error("Cancellation was not received before the backend result.");
    }
  } }).catch((error) => { bridgeError = error; }).finally(() => { bridgeSettledAt = Date.now(); });
  let cancelOffset = 0;
  const started = Date.now();
  for (let offset = 0; Date.now() - started < 32_000; offset += 960) {
    if (toolStarted && !injectedAt && (scenario === "disconnect" || String(report.assistantTranscript).length > 0)) {
      injectedAt = Date.now();
      report.injectedWhileBackendPending = backendPending;
      timeline.push({ event: scenario, at: injectedAt });
      if (scenario === "disconnect") { terminate(); break; }
    }
    const chunk = cancel && injectedAt && cancelOffset < cancel.length
      ? cancel.subarray(cancelOffset, (cancelOffset += 960))
      : offset < input.length ? input.subarray(offset, offset + 960) : Buffer.alloc(960);
    await session.sendAudio({ data: chunk, mediaType: "audio/pcm", sampleRateHz: 24000 });
    await delay(20);
  }
  if (scenario === "disconnect") {
    if (!injectedAt || !context) throw new Error("Disconnect injection did not reach an active agent.");
    await Promise.race([Promise.all([bridge, events]), delay(3000).then(() => { throw new Error("Disconnect did not settle within 3 seconds."); })]);
    report.abortObserved = context.signal.aborted;
    report.settledAfterDisconnectMs = bridgeSettledAt - injectedAt;
    report.bridgeErrorObserved = Boolean(bridgeError);
    report.transportErrorObserved = Boolean(eventError);
    try { await context.sendUpdate({ kind: "commentary", content: "Late result must not be sent." }); report.lateUpdateRejected = false; }
    catch { report.lateUpdateRejected = true; }
    report.passed = Boolean(report.injectedWhileBackendPending && report.abortObserved && report.bridgeErrorObserved && report.transportErrorObserved && report.lateUpdateRejected && !report.finalUsageConfirmed && Number(report.toolExecutions) === 1);
  } else {
    await session.close();
    await Promise.all([bridge, events]);
    if (bridgeError || eventError) throw bridgeError ?? eventError;
    report.passed = Boolean(report.injectedWhileBackendPending && report.cancellationObservedWhileBackendPending && report.bridgeSignalAbortedOnSpeech === false && report.staleResultSuppressed && Number(report.toolExecutions) === 1 && /cancel/i.test(String(report.assistantTranscript)) && !String(report.assistantTranscript).toLowerCase().includes(expectedCode) && report.finalUsageConfirmed);
  }
  if (!report.passed) throw new Error("Fault scenario assertions failed.");
} catch (error) {
  report.passed = false;
  report.error = String(error instanceof Error ? error.message : error).replaceAll(openaiKey, "[REDACTED]").replaceAll(qwenKey, "[REDACTED]");
  process.exitCode = 1;
} finally {
  controller.abort();
  if (session) await session.close().catch(() => undefined);
  terminate();
  await Promise.allSettled([events, bridge, ...pendingAgents]);
  clearTimeout(deadline);
  report.agentRuns = agentRuns;
  const errorText = (error: unknown) => error === undefined ? undefined : String(error instanceof Error ? error.message : error).replaceAll(openaiKey, "[REDACTED]").replaceAll(qwenKey, "[REDACTED]");
  report.bridgeError = errorText(bridgeError);
  report.eventError = errorText(eventError);
  report.timeline = timeline;
  report.finishedAt = new Date().toISOString();
  await writeFile(`/tmp/zhivex-openai-live-${scenario}-smoke.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
