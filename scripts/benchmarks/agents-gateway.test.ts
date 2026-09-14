import { expect, it } from "vitest";
import { coveredTime, percentile, validateFixture, runTrial } from "./agents-gateway.mjs";
it("uses nearest-rank percentiles and rejects invalid samples", () => {
  expect(percentile([4, 1, 3, 2], .5)).toBe(2);
  expect(percentile([4, 1, 3, 2], .95)).toBe(4);
  expect(() => percentile([], .5)).toThrow();
  expect(() => percentile([NaN], .95)).toThrow();
  expect(coveredTime([[1, 4], [2, 3], [3, 6], [10, 12]])).toBe(7);
});
it("rejects invalid workloads before execution", () => {
  for (const patch of [{ steps: 101 }, { concurrency: 0 }, { payloadBytes: 100000 }, { scenario: "live" }, { seed: -1 }]) {
    expect(() => validateFixture({ scenario: "tools", steps: 1, concurrency: 1, payloadBytes: 64, seed: 42, ...patch })).toThrow();
  }
});
it("validates effects, model steps and checkpoints on a tiny workload", async () => {
  const trial = await runTrial({ scenario: "checkpoints", steps: 3, concurrency: 2, payloadBytes: 64, seed: 42 });
  expect(trial.modelCalls).toBe(6);
  expect(trial.effects).toBe(4);
  expect(trial.checkpoints).toBeGreaterThan(0);
  expect(trial.checkpointBytes).toBeGreaterThan(0);
});
