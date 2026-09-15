import { GatewayError, type GatewayModelTarget } from "./types.js";
export type GatewayCircuitState = "closed" | "open" | "half-open";
export interface GatewayCircuitSnapshot { state: GatewayCircuitState; failures: number; inFlight: number; openUntil?: number; }
export interface GatewayCircuitPermit { end(outcome: "success" | "retryable-error" | "neutral", retryAfterMs?: number): void; }
export interface GatewayCircuitBreaker {
  acquire(target: GatewayModelTarget): GatewayCircuitPermit | undefined;
  snapshot(target: GatewayModelTarget): GatewayCircuitSnapshot | undefined;
  canAttempt(target: GatewayModelTarget): boolean;
}
export interface GatewayCircuitOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  halfOpenMaxProbes?: number;
  maxTargets?: number;
  now?: () => number;
  onStateChange?: (event: { target: GatewayModelTarget; from: GatewayCircuitState; to: GatewayCircuitState; at: number; openUntil?: number }) => void | Promise<void>;
}
export class GatewayCircuitOpenError extends GatewayError {
  constructor() { super("All eligible destination circuits are open or have exhausted probe capacity.", true); this.name = "GatewayCircuitOpenError"; }
}
export const createGatewayCircuitBreaker = (options: GatewayCircuitOptions = {}): GatewayCircuitBreaker => {
  const threshold = options.failureThreshold ?? 5, cooldown = options.cooldownMs ?? 30_000, maxCooldown = options.maxCooldownMs ?? 60_000, probes = options.halfOpenMaxProbes ?? 1, capacity = options.maxTargets ?? 128;
  for (const [value, max] of [[threshold, 1000], [cooldown, 86_400_000], [maxCooldown, 86_400_000], [probes, 100], [capacity, 10_000]]) {
    if (!Number.isSafeInteger(value) || value! < 1 || value! > max!) throw new GatewayError("Invalid circuit breaker limits.", false);
  }
  if (cooldown > maxCooldown) throw new GatewayError("cooldownMs cannot exceed maxCooldownMs.", false);
  const now = options.now ?? Date.now;
  type Entry = GatewayCircuitSnapshot & { epoch: number; touched: number };
  const entries = new Map<string, Entry>();
  const key = (target: GatewayModelTarget) => JSON.stringify([target.provider, target.modelId]);
  const transition = (entry: Entry, target: GatewayModelTarget, to: GatewayCircuitState) => {
    const from = entry.state; entry.state = to; entry.epoch++;
    if (from === to || !options.onStateChange) return;
    const event = { target: { ...target }, from, to, at: now(), openUntil: entry.openUntil };
    queueMicrotask(() => { try { void Promise.resolve(options.onStateChange!(event)).catch(() => undefined); } catch { /* Observer failure cannot change policy. */ } });
  };
  return {
    canAttempt(target) {
      const entry = entries.get(key(target));
      return !entry || entry.state === "closed" || ((entry.state === "half-open" || now() >= entry.openUntil!) && entry.inFlight < probes);
    },
    acquire(target) {
      const at = now(), id = key(target);
      let entry = entries.get(id);
      if (!entry) {
        if (entries.size >= capacity) {
          const idle = [...entries].filter(([, x]) => x.inFlight === 0 && x.state === "closed").sort((a, b) => a[1].touched - b[1].touched)[0];
          if (!idle) return undefined;
          entries.delete(idle[0]);
        }
        entry = { state: "closed", failures: 0, inFlight: 0, epoch: 0, touched: at }; entries.set(id, entry);
      }
      if (entry.state === "open") {
        if (at < entry.openUntil!) return undefined;
        transition(entry, target, "half-open");
      }
      if (entry.state === "half-open" && entry.inFlight >= probes) return undefined;
      entry.inFlight++; entry.touched = at;
      const epoch = entry.epoch; let ended = false;
      return { end(outcome, retryAfterMs) {
        if (ended) return; ended = true; entry!.inFlight--; entry!.touched = now();
        if (epoch !== entry!.epoch) return;
        if (outcome === "success") { entry!.failures = 0; entry!.openUntil = undefined; if (entry!.state !== "closed") transition(entry!, target, "closed"); }
        if (outcome === "retryable-error") {
          entry!.failures++;
          if (entry!.state === "half-open" || entry!.failures >= threshold) {
            const serverDelay = Number.isFinite(retryAfterMs) && retryAfterMs! > 0 ? retryAfterMs! : 0;
            entry!.openUntil = now() + Math.min(maxCooldown, Math.max(cooldown, serverDelay));
            transition(entry!, target, "open");
          }
        }
      } };
    },
    snapshot(target) { const entry = entries.get(key(target)); if (!entry) return undefined; const { state, failures, inFlight, openUntil } = entry; return { state, failures, inFlight, openUntil }; }
  };
};
