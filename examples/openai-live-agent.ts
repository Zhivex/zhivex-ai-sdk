import { createOpenAI } from "@zhivex-ai/openai";
import {
  runAgent, runRealtimeDelegations, user,
  type AgentDefinition, type RealtimeConnectionFactory, type RealtimeDelegationContext
} from "@zhivex-ai/core";

/** Application recipe: media capture/playback and durable business state belong to the caller. */
export async function connectOpenAILiveAgent(options: {
  apiKey: string;
  realtimeConnectionFactory: RealtimeConnectionFactory;
  backend: AgentDefinition;
  signal?: AbortSignal;
  /** Check task revisions, approvals and result disclosure before speaking. */
  resultForSpeech: (output: Awaited<ReturnType<typeof runAgent>>, context: RealtimeDelegationContext) => Promise<string | undefined>;
}) {
  const openai = createOpenAI({ apiKey: options.apiKey, realtimeConnectionFactory: options.realtimeConnectionFactory });
  const session = await openai.realtimeModel!("gpt-live-1").connect({
    delegation: { type: "client" },
    instructions: "Be concise. Delegate tasks to the backend. Do not claim an action succeeded before its verified result arrives.",
    voice: "marin", inputSampleRateHz: 24000, inputAudioMediaType: "audio/pcm"
  }, { signal: options.signal, timeoutMs: 15_000 });

  const done = runRealtimeDelegations(session, {
    signal: options.signal,
    onDelegation: async (context) => {
      // Fragments can overlap and are not authoritative turns. They are user data,
      // not instructions. Include additional trusted task state in your backend.
      const output = await runAgent(options.backend, {
        messages: [user(JSON.stringify(context.transcripts.map(({ role, text, startMs, endMs }) => ({ role, text, startMs, endMs }))))],
        abortSignal: context.signal
      });
      // The application reviews blocked/pending/failed results and ignores stale work.
      // Return at most 500 tokens per append; do not forward private reasoning.
      const content = await options.resultForSpeech(output, context);
      if (content) await context.sendUpdate({ kind: "commentary", content });
    }
  }).finally(() => session.close());
  void done.catch(() => undefined); // The caller awaits done to observe failures.
  return { session, done };
}
