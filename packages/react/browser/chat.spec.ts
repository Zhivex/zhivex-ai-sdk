import { expect, test } from "@playwright/test";

test("reconnects a truncated response with GET and renders every token exactly once", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const before = await (await request.get("/metrics")).json();
  await page.goto("/?view=disconnect");
  await page.getByRole("textbox").fill("hello");
  await page.getByRole("textbox").press("Enter");
  await expect(page.locator('[data-role="assistant"]')).toContainText("token9");
  await expect(page.getByLabel("Chat status")).toHaveText("ready");
  const text = await page.locator('[data-role="assistant"] .zhivex-message__content').innerText();
  for (let i = 0; i < 10; i++) expect(text.match(new RegExp(`token${i}`, "g"))).toHaveLength(1);
  const after = await (await request.get("/metrics")).json();
  expect(after.runs - before.runs).toBe(1);
  expect(after.reconnects - before.reconnects).toBe(1);
  expect(errors).toEqual([]);
});

test("virtualizes a thousand variable-height messages and preserves scroll intent", async ({ page }) => {
  await page.goto("/?view=virtual");
  const log = page.getByRole("log");
  await expect(log).toContainText("History 999");
  expect(await page.locator('[data-slot="message"]').count()).toBeLessThan(40);
  await log.evaluate((element) => { element.scrollTop = 0; });
  await expect(log).toContainText("History 0");
  await page.getByRole("textbox").fill("new question");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Chat status")).toHaveText("ready");
  await expect(log).toContainText("History 0");
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(log).toContainText("token9");
});

test("supports real file input, validates drop and paste, and cancels uploads", async ({ page }) => {
  await page.goto("/?view=upload");
  await page.locator('input[type="file"]').setInputFiles({ name: "ok.txt", mimeType: "text/plain", buffer: Buffer.from("data") });
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Remove attachment: ok.txt" }).click();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await page.getByRole("textbox").evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File(["bad"], "bad.pdf", { type: "application/pdf" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("alert")).toContainText("not accepted");
  await page.locator("form").evaluate((element) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["good"], "drop.txt", { type: "text/plain" }));
    element.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('[data-attachment-status="ready"]')).toContainText("drop.txt");
});

test("keeps keyboard focus, respects IME composition, and renders Markdown", async ({ page }) => {
  await page.goto("/?view=markdown");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.locator("code.language-ts")).toContainText("const answer = 42;");
  const input = page.getByRole("textbox");
  await input.fill("composition");
  await input.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  await expect(input).toHaveValue("composition");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("composition\n");
  await input.press("Enter");
  await expect(input).toBeFocused();
  await expect(page.getByLabel("Chat status")).toHaveText("ready");
});


test("copies code and cancels a live response without reconnecting", async ({ page, context, request }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?view=markdown");
  await page.locator(".zhivex-code-block").getByRole("button").click();
  await expect(page.locator(".zhivex-code-block").getByRole("button")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("const answer = 42;");
  const before = await (await request.get("/metrics")).json();
  await page.getByRole("textbox").fill("cancel me");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("token0");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByLabel("Chat status")).toHaveText("ready");
  await expect(page.getByRole("textbox")).toHaveValue("cancel me");
  const after = await (await request.get("/metrics")).json();
  expect(after.reconnects).toBe(before.reconnects);
  expect(after.runs - before.runs).toBe(1);
  await page.screenshot({ path: ".cache/react-browser/chat.png", fullPage: true });
});

test("runs Qwen media mapping, approval and replay without repeating the tool", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const before = await (await request.get("/metrics")).json();
  let disconnected = false;
  await page.route("**/omni", async route => {
    if (route.request().method() !== "POST" || disconnected) return route.continue();
    disconnected = true;
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response, body: body.slice(0, body.indexOf("\n\n") + 2) });
  });
  await page.goto("/?view=omni");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "image.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64") },
    { name: "audio.wav", mimeType: "audio/wav", buffer: Buffer.from("offline audio fixture") },
    { name: "video.mp4", mimeType: "video/mp4", buffer: Buffer.from("offline video fixture") }
  ]);
  await expect(page.locator('[data-attachment-status="ready"]')).toHaveCount(3);
  await expect(page.locator('video')).toHaveCount(1);
  await page.getByRole("textbox").fill("Analyze the media and consult context.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Agent executions" })).toContainText("waiting approval");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("Media reviewed with approved context.");
  await expect(page.locator('[data-slot="agent-runs"]')).toContainText("completed");
  const after = await (await request.get("/metrics")).json();
  expect(after.toolExecutions - before.toolExecutions).toBe(1);
  expect(after.mediaTypes).toEqual(expect.arrayContaining(["image_url", "input_audio", "video_url"]));
  expect(errors).toEqual([]);
});

test("captures PCM through the WebSocket relay and releases the microphone on disconnect", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const before = await (await request.get("/metrics")).json();
  await page.goto("/?view=voice");
  await page.getByRole("button", { name: "Connect voice", exact: true }).click();
  await expect(page.getByLabel("Voice status")).toHaveText("connected");
  await expect(page.locator("ol")).toContainText("Voice connected");
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop microphone" })).toBeVisible();
  await expect.poll(async () => (await (await request.get("/metrics")).json()).audioFrames).toBeGreaterThan(before.audioFrames);
  await page.getByRole("button", { name: "Stop microphone" }).click();
  await page.getByRole("button", { name: "Start microphone" }).click();
  await expect(page.getByRole("button", { name: "Stop microphone" })).toBeVisible();
  await page.getByRole("button", { name: "Interrupt voice" }).click();
  await expect.poll(async () => (await (await request.get("/metrics")).json()).interruptions).toBeGreaterThan(before.interruptions);
  await page.getByRole("button", { name: "Disconnect voice", exact: true }).click();
  await expect(page.getByLabel("Voice status")).toHaveText("disconnected");
  await expect(page.getByRole("button", { name: "Start microphone" })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("Omni starter prompts preserve keyboard focus and fit a narrow dark viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/?view=omni");
  await page.getByRole("button", { name: "Help me analyze my media" }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Help me analyze my media");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".cache/react-browser/omni-mobile-dark.png", fullPage: true });
  await page.goto("/?view=voice");
  await expect(page.getByRole("button", { name: "Start microphone" })).toBeDisabled();
  await expect(page.getByLabel("Prefer typing? Send a message to the voice session.")).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".cache/react-browser/voice-mobile-dark.png", fullPage: true });
});
