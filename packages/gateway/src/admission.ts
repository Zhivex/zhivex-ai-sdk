import { GatewayError, type GatewayModelTarget } from "./types.js";
import { targetKey } from "./target.js";
export class GatewayAdmissionError extends GatewayError {
  constructor() { super("Gateway destination admission capacity exhausted.", false); this.name = "GatewayAdmissionError"; }
}
export interface GatewayAdmissionLease { release(actualTokens?: number): void | Promise<void>; }
/** Remote implementations must reserve atomically, honor abort, and expire abandoned leases. */
export interface GatewayAdmissionController {
  acquire(input: { target: GatewayModelTarget; tokens?: number; signal?: AbortSignal }): Promise<GatewayAdmissionLease>;
}
export interface GatewayAdmissionOptions {
  maxConcurrent: number;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  maxQueue?: number;
  queueTimeoutMs?: number;
  maxTargets?: number;
  now?: () => number;
}
export const createGatewayAdmissionController = (options: GatewayAdmissionOptions): GatewayAdmissionController => {
  const maxQueue = options.maxQueue ?? 0, queueTimeout = options.queueTimeoutMs ?? 1000, maxTargets = options.maxTargets ?? 128;
  for (const n of [options.maxConcurrent, queueTimeout, maxTargets, options.requestsPerMinute ?? 1, options.tokensPerMinute ?? 1]) {
    if (!Number.isSafeInteger(n) || n < 1) throw new GatewayError("Admission limits must be positive safe integers.", false);
  }
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 0 || maxQueue > 10000 || maxTargets > 10000 || queueTimeout > 60000) throw new GatewayError("Invalid admission queue/capacity.", false);
  const now = options.now ?? Date.now;
  type Entry = { active: number; requests: number; tokens: number; resetAt: number };
  const entries = new Map<string, Entry>();
  let queued = 0;
  return {
    async acquire({ target, tokens, signal }) {
      if ((tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < 0)) || (options.tokensPerMinute !== undefined && tokens === undefined)) throw new GatewayError("Invalid admission token reservation.", false);
      if (options.tokensPerMinute !== undefined && tokens! > options.tokensPerMinute) throw new GatewayAdmissionError();
      const reservedTokens = tokens ?? 0;
      const id = targetKey(target), deadline = Date.now() + queueTimeout;
      let waiting = false;
      try {
        for (;;) {
          signal?.throwIfAborted();
          const at = now();
          let entry = entries.get(id);
          if (!entry) {
            if (entries.size >= maxTargets) {
              const disposable = [...entries].find(([, value]) => value.active === 0 && at >= value.resetAt);
              if (disposable) entries.delete(disposable[0]);
              else throw new GatewayAdmissionError();
            }
            entry = { active: 0, requests: 0, tokens: 0, resetAt: at + 60000 }; entries.set(id, entry);
          }
          if (at >= entry.resetAt) { entry.requests = 0; entry.tokens = 0; entry.resetAt = at + 60000; }
          if (entry.active < options.maxConcurrent && entry.requests < (options.requestsPerMinute ?? Infinity) && entry.tokens + reservedTokens <= (options.tokensPerMinute ?? Infinity)) {
            entry.active++; entry.requests++; entry.tokens += reservedTokens;
            const window = entry.resetAt;
            let released = false;
            return { release(actualTokens) { if (!released) { released = true; entry!.active--;
              if (entry!.resetAt === window && actualTokens !== undefined && Number.isSafeInteger(actualTokens) && actualTokens >= 0) entry!.tokens = Math.max(0, entry!.tokens + actualTokens - reservedTokens);
            } } };
          }
          if (!waiting) { if (queued >= maxQueue) throw new GatewayAdmissionError(); queued++; waiting = true; }
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new GatewayAdmissionError();
          await new Promise<void>((resolve, reject) => {
            const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
            const abort = () => { clean(); reject(signal!.reason); };
            const timer = setTimeout(() => { clean(); resolve(); }, Math.min(10, remaining));
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        }
      } finally { if (waiting) queued--; }
    }
  };
};
