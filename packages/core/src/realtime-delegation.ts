import { ConfigurationError, ConflictError } from "./errors.js";
import type { RealtimeContextUpdate, RealtimeDelegationEvent, RealtimeSession, RealtimeTranscriptEvent } from "./types.js";

export interface RealtimeDelegationContext {
  delegation: RealtimeDelegationEvent;
  /** Original fragments at delegation receipt. Preserve timing and overlapping speakers. */
  transcripts: readonly RealtimeTranscriptEvent[];
  signal: AbortSignal;
  /** Sends a verified update with the original delegation ID. Does not prove playback. */
  sendUpdate(update: Omit<RealtimeContextUpdate, "delegationId">): Promise<void>;
}

export interface RealtimeDelegationOptions {
  /** Invoke your agent/workflow here; it owns permissions, durable task state and tool execution. */
  onDelegation(context: RealtimeDelegationContext): Promise<void>;
  signal?: AbortSignal;
  maxTranscriptChars?: number;
  maxDelegations?: number;
  maxPendingDelegations?: number;
}

const abortReason = (signal: AbortSignal): Error => signal.reason instanceof Error
  ? signal.reason : new DOMException("Realtime delegation stopped.", "AbortError");

const untilAbort = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
};

/**
 * Consume client delegations without blocking audio/transcript reception. Backend
 * tasks run serially; speech interruptions never cancel them implicitly. Keep
 * durable operation IDs and task revisions in the backend, independently of IDs
 * scoped to this voice session. Close the session in the caller's finally block.
 */
export async function runRealtimeDelegations(session: RealtimeSession, options: RealtimeDelegationOptions): Promise<void> {
  if (!session.capabilities.realtime?.clientDelegation || !session.appendContext) {
    throw new ConfigurationError("This session does not support client delegation.");
  }
  const maxChars = options.maxTranscriptChars ?? 65_536;
  const maxDelegations = options.maxDelegations ?? 1024;
  const maxPending = options.maxPendingDelegations ?? 8;
  for (const value of [maxChars, maxDelegations, maxPending]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigurationError("Delegation limits must be positive safe integers.");
  }
  const controller = new AbortController();
  const signal = controller.signal;
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const transcripts: RealtimeTranscriptEvent[] = [];
  const seen = new Map<string, number | undefined>();
  let chars = 0;
  let pending = 0;
  let chain = Promise.resolve();
  const iterator = session.eventStream()[Symbol.asyncIterator]();
  try {
    while (true) {
      if (signal.aborted) throw abortReason(signal);
      const next = await untilAbort(iterator.next(), signal);
      if (next.done) break;
      const event = next.value;
      if (event.type === "realtime-error") throw event.error ?? new Error(event.message ?? "Realtime session failed.");
      if (event.type === "realtime-end") break;
      if (event.type === "realtime-transcript") {
        chars += event.text.length;
        // Count empty fragments too, to bound memory independently of text length.
        if (chars > maxChars || transcripts.length >= maxChars) throw new ConfigurationError("Realtime delegation transcript limit exceeded; persist context and start a new session.");
        transcripts.push(structuredClone(event));
      }
      if (event.type !== "realtime-delegation") continue;
      if (seen.has(event.delegationId)) {
        if (seen.get(event.delegationId) !== event.offsetMs) throw new ConflictError("Realtime delegation ID was reused with different timing.");
        continue;
      }
      if (seen.size >= maxDelegations || pending >= maxPending) throw new ConfigurationError("Realtime delegation queue limit exceeded.");
      seen.set(event.delegationId, event.offsetMs);
      pending++;
      const snapshot = structuredClone(transcripts);
      const delegation = structuredClone(event);
      chain = chain.then(async () => {
        if (signal.aborted) return;
        await untilAbort(Promise.resolve().then(() => {
          if (signal.aborted) throw abortReason(signal);
          return options.onDelegation({
          delegation,
          transcripts: snapshot,
          signal,
          sendUpdate: async (update) => {
            if (signal.aborted) throw abortReason(signal);
            await untilAbort(session.appendContext!({ ...update, delegationId: event.delegationId }), signal);
          }
          });
        }), signal);
      }).catch((error: unknown) => { controller.abort(error); }).finally(() => { pending--; });
    }
    if (signal.aborted) throw abortReason(signal);
  } finally {
    // Voice-session termination invalidates updates, even for non-cooperative backends.
    controller.abort(new DOMException("Voice session ended.", "AbortError"));
    options.signal?.removeEventListener("abort", onAbort);
    void iterator.return?.().catch(() => undefined);
    await chain;
  }
}
