import { expect, test } from "@playwright/test";

test.skip(process.env.QWEN_REACT_INTEGRATION !== "1", "Explicit opt-in required for paid provider calls.");

test("real Qwen agent requests approval, resumes, and reports completion", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  const chat = page.getByRole("region", { name: "AI chat" });
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Consult context by calling lookup_media_context, then report the exact context returned by that tool.");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("region", { name: "Agent executions" })).toContainText("waiting approval");
  await page.screenshot({ path: ".cache/react-live-results/approval.png", fullPage: true });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(chat.locator('[data-role="assistant"]').last()).toContainText("no automatic publication", { timeout: 60000 });
  await expect(page.getByRole("region", { name: "Agent executions" })).toContainText("completed");
  expect(errors).toEqual([]);
  await page.screenshot({ path: ".cache/react-live-results/completed.png", fullPage: true });
});

test("real Qwen voice returns transcript and browser audio through the WebSocket relay", async ({ page }) => {
  let audioFrames = 0;
  page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.event?.type === "realtime-audio-output" && frame.event.audio?.length > 0) audioFrames++;
  }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Connect voice", exact: true }).click();
  await expect(page.getByLabel("Voice status")).toHaveText("connected", { timeout: 30000 });
  await page.getByLabel("Prefer typing? Send a message to the voice session.").fill("Say exactly: Voice certification complete.");
  await page.getByRole("button", { name: "Send to voice" }).click();
  await expect(page.getByLabel("Voice transcript")).toContainText(/certification/i, { timeout: 30000 });
  await expect.poll(() => audioFrames).toBeGreaterThan(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: ".cache/react-live-results/voice.png", fullPage: true });
  await page.getByRole("button", { name: "Disconnect voice", exact: true }).click();
  await expect(page.getByLabel("Voice status")).toHaveText("disconnected");
  expect(errors).toEqual([]);
});
