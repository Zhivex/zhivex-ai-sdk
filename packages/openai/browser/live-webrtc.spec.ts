import { test, expect } from "@playwright/test";
test("real browser loopback negotiates audio/ICE/events and confirms close without device access", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // Any accidental device capture must fail the test even without granted permissions.
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("Device capture prohibited"); };
    return (window as any).runLiveWebRTCLoopback();
  });
  expect(result.events).toContainEqual(expect.objectContaining({ type: "realtime-transcript", text: "Synthetic loopback" }));
  expect(result.events.at(-1)).toMatchObject({ type: "realtime-end", providerMetadata: { usage: { seconds: 1 } } });
  expect(result.remoteTrackCount).toBe(1); expect(result.releaseCount).toBe(0);
  expect(result.callerTrackState).toBe("live"); expect(result.peerState).toBe("closed"); expect(errors).toEqual([]);
});
