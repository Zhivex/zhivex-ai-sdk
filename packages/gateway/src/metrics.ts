import { targetKey } from "./target.js";
import { GatewayError, type GatewayModelTarget } from "./types.js";
export type GatewayMetricOutcome = "success" | "error" | "cancelled" | "cache";
export interface GatewayMetricsSnapshot {
  inFlight: number;
  sampleCount: number;
  successes: number;
  errors: number;
  cancellations: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  p95TtftMs?: number;
  p50TokensPerSecond?: number;
  lastCompletedAt?: number;
}
export interface GatewayMetricsHandle {
  firstText(): void;
  end(outcome: GatewayMetricOutcome, outputTokens?: number): void;
}
export interface GatewayMetricsStore {
  begin(target: GatewayModelTarget): GatewayMetricsHandle | undefined;
  snapshot(target: GatewayModelTarget): GatewayMetricsSnapshot | undefined;
}
export interface GatewayMetricsOptions {
  windowMs?: number;
  maxTargets?: number;
  maxSamplesPerTarget?: number;
  now?: () => number;
}
interface Sample { at: number; latencyMs: number; ttftMs?: number; outcome: GatewayMetricOutcome; tokensPerSecond?: number; }
/** Bounded, process-local metrics. New targets are untracked while every capacity slot is active. */
export const createGatewayMetrics = (options: GatewayMetricsOptions = {}): GatewayMetricsStore => {
  const windowMs = options.windowMs ?? 60_000, maxTargets = options.maxTargets ?? 128, maxSamples = options.maxSamplesPerTarget ?? 256;
  for (const [name, value, max] of [["windowMs", windowMs, 86_400_000], ["maxTargets", maxTargets, 10_000], ["maxSamplesPerTarget", maxSamples, 10_000]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new GatewayError(`Invalid metrics ${name}.`, false);
  }
  const now = options.now ?? Date.now;
  const entries = new Map<string, { inFlight: number; samples: Sample[]; touched: number }>();
  const key = targetKey;
  const expire = (entry: { samples: Sample[] }, at: number) => { entry.samples = entry.samples.filter(x => x.at > at - windowMs); };
  const percentile = (sorted: number[], fraction: number) => sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : undefined;
  return {
    begin(target) {
      const id = key(target), started = now();
      let entry = entries.get(id);
      if (!entry) {
        if (entries.size >= maxTargets) {
          const idle = [...entries].filter(([, x]) => x.inFlight === 0).sort((a, b) => a[1].touched - b[1].touched)[0];
          if (!idle) return undefined;
          entries.delete(idle[0]);
        }
        entry = { inFlight: 0, samples: [], touched: started }; entries.set(id, entry);
      }
      entry.inFlight++; entry.touched = started;
      let ended = false, ttftMs: number | undefined;
      return {
        firstText() { if (!ended && ttftMs === undefined) ttftMs = Math.max(0, now() - started); },
        end(outcome, outputTokens) {
          if (ended) return; ended = true;
          const at = now(); entry!.inFlight--; entry!.touched = at;
          expire(entry!, at);
          const duration = at - started - (ttftMs ?? 0);
          const tokensPerSecond = outcome === "success" && ttftMs !== undefined && outputTokens !== undefined && Number.isSafeInteger(outputTokens) && outputTokens > 1 && duration > 0 ? (outputTokens - 1) * 1000 / duration : undefined;
          entry!.samples.push({ ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}), at, latencyMs: Math.max(0, at - started), ...(ttftMs !== undefined ? { ttftMs } : {}), outcome });
          if (entry!.samples.length > maxSamples) entry!.samples.splice(0, entry!.samples.length - maxSamples);
        }
      };
    },
    snapshot(target) {
      const entry = entries.get(key(target)); if (!entry) return undefined;
      expire(entry, now());
      const samples = entry.samples;
      // Cancelled requests never become provider latency/error evidence.
      const completed = samples.filter(x => x.outcome !== "cancelled" && x.outcome !== "cache");
      const latencies = completed.map(x => x.latencyMs).sort((a, b) => a - b);
      const firstText = completed.flatMap(x => x.ttftMs === undefined ? [] : [x.ttftMs]).sort((a, b) => a - b);
      const throughput = completed.flatMap(x => x.tokensPerSecond === undefined ? [] : [x.tokensPerSecond]).sort((a, b) => a - b);
      return { p50TokensPerSecond: percentile(throughput, .5), inFlight: entry.inFlight, sampleCount: samples.length, successes: samples.filter(x => x.outcome === "success").length,
        errors: samples.filter(x => x.outcome === "error").length, cancellations: samples.filter(x => x.outcome === "cancelled").length,
        p50LatencyMs: percentile(latencies, .5), p95LatencyMs: percentile(latencies, .95),
        p95TtftMs: percentile(firstText, .95), lastCompletedAt: samples.at(-1)?.at };
    }
  };
};
