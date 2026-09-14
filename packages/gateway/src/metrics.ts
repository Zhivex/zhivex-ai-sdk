import { GatewayError, type GatewayModelTarget } from "./types.js";
export type GatewayMetricOutcome = "success" | "error" | "cancelled";
export interface GatewayMetricsSnapshot {
  inFlight: number;
  sampleCount: number;
  successes: number;
  errors: number;
  cancellations: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  p95TtftMs?: number;
  lastCompletedAt?: number;
}
export interface GatewayMetricsHandle {
  firstText(): void;
  end(outcome: GatewayMetricOutcome): void;
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
interface Sample { at: number; latencyMs: number; ttftMs?: number; outcome: GatewayMetricOutcome; }
/** Bounded, process-local metrics. New targets are untracked while every capacity slot is active. */
export const createGatewayMetrics = (options: GatewayMetricsOptions = {}): GatewayMetricsStore => {
  const windowMs = options.windowMs ?? 60_000, maxTargets = options.maxTargets ?? 128, maxSamples = options.maxSamplesPerTarget ?? 256;
  for (const [name, value, max] of [["windowMs", windowMs, 86_400_000], ["maxTargets", maxTargets, 10_000], ["maxSamplesPerTarget", maxSamples, 10_000]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new GatewayError(`Invalid metrics ${name}.`, false);
  }
  const now = options.now ?? Date.now;
  const entries = new Map<string, { inFlight: number; samples: Sample[]; touched: number }>();
  const key = (target: GatewayModelTarget) => JSON.stringify([target.provider, target.modelId]);
  const expire = (entry: { samples: Sample[] }, at: number) => { entry.samples = entry.samples.filter(x => x.at > at - windowMs); };
  const percentile = (values: number[], fraction: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : undefined;
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
        end(outcome) {
          if (ended) return; ended = true;
          const at = now(); entry!.inFlight--; entry!.touched = at;
          expire(entry!, at);
          entry!.samples.push({ at, latencyMs: Math.max(0, at - started), ...(ttftMs !== undefined ? { ttftMs } : {}), outcome });
          if (entry!.samples.length > maxSamples) entry!.samples.splice(0, entry!.samples.length - maxSamples);
        }
      };
    },
    snapshot(target) {
      const entry = entries.get(key(target)); if (!entry) return undefined;
      expire(entry, now());
      const samples = entry.samples;
      // Cancelled requests never become provider latency/error evidence.
      const completed = samples.filter(x => x.outcome !== "cancelled");
      return { inFlight: entry.inFlight, sampleCount: samples.length, successes: samples.filter(x => x.outcome === "success").length,
        errors: samples.filter(x => x.outcome === "error").length, cancellations: samples.filter(x => x.outcome === "cancelled").length,
        p50LatencyMs: percentile(completed.map(x => x.latencyMs), .5), p95LatencyMs: percentile(completed.map(x => x.latencyMs), .95),
        p95TtftMs: percentile(completed.flatMap(x => x.ttftMs === undefined ? [] : [x.ttftMs]), .95), lastCompletedAt: samples.at(-1)?.at };
    }
  };
};
