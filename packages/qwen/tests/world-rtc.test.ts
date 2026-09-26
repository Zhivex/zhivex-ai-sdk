import { expect, it, vi } from "vitest";
import { createQwenWorldRTC } from "../src/world-rtc.js";
const config = { APIHost: "maas.qwencloudapi.com", model: "happyoyster-1.0-adventure" as const, token: "st-test" };
it("preserves native RTC controls and cleans up a failed start", async () => {
  const travel = { start: vi.fn(async () => { throw new Error("RTC unavailable"); }), end: vi.fn(async () => {}), sendCommand: vi.fn() };
  const engine = { createTravel: vi.fn(() => travel), updateToken: vi.fn() };
  const bridge = createQwenWorldRTC(() => engine, config);
  await expect(bridge.startTravel({ ticket: "ticket", videoElement: {} as HTMLVideoElement })).rejects.toThrow("RTC unavailable");
  expect(travel.end).toHaveBeenCalledOnce();
  expect(bridge.createTravel({ ticket: "ticket2", videoElement: {} as HTMLVideoElement }).sendCommand).toBe(travel.sendCommand);
});
it("rejects primary credentials and invalid hosts before creating an engine", () => {
  const factory = vi.fn();
  expect(() => createQwenWorldRTC(factory, { ...config, token: "sk-primary" })).toThrow("temporary");
  expect(() => createQwenWorldRTC(factory, { ...config, APIHost: "https://example.com/path" })).toThrow("bare host");
  expect(factory).not.toHaveBeenCalled();
});
it("reports failed cleanup explicitly", async () => {
  const bridge = createQwenWorldRTC(() => ({ updateToken() {}, createTravel: () => ({ start: async () => { throw new Error("start"); }, end: async () => { throw new Error("end"); } }) }), config);
  await expect(bridge.startTravel({ ticket: "ticket", videoElement: {} as HTMLVideoElement })).rejects.toThrow("verify the travel has ended");
});
