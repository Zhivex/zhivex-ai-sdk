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
