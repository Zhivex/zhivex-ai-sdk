import { chromium } from "@playwright/test";

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error("Set MODEL_API_KEY before running this example.");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  await page.setContent('<button id="filters" onclick="this.dataset.clicked=\'true\';this.textContent=\'Filters open\'" style="position:absolute;left:100px;top:100px;width:300px;height:150px;font-size:32px">Show filters</button>');
  const screenshot = async () => `data:image/png;base64,${(await page.screenshot()).toString("base64")}`;
  const send = async (body: Record<string, unknown>) => {
    const response = await fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Meta native computer request failed with HTTP ${response.status}.`);
    return response.json() as Promise<{ id: string; status?: string; output?: Array<{
      type?: string; call_id?: string; actions?: Array<{ type?: string; x?: number; y?: number; button?: string }>;
      pending_safety_checks?: Array<{ id: string; code: string; message: string }>;
    }> }>;
  };
  let payload = await send({
      model: "muse-spark-1.3-contributor",
      tools: [{ type: "computer" }],
      store: true,
      input: [{ role: "user", content: [
        { type: "input_text", text: "Use the computer tool to click the Show filters button in this synthetic page." },
        { type: "input_image", image_url: await screenshot() }
      ] }]
  });
  const actionTypes: string[] = [];
  let steps = 0;
  for (; steps < 6; steps++) {
    const calls = payload.output?.filter((item) => item.type === "computer_call") ?? [];
    if (calls.length === 0) break;
    if (calls.length !== 1 || !calls[0]?.call_id) throw new Error("Native computer call has an invalid shape.");
    const call = calls[0];
    const checks = call.pending_safety_checks ?? [];
    if (checks.some((check) => check.code !== "computer_action_requires_confirmation" || !check.id)) {
      throw new Error("Native computer call has an unexpected safety check.");
    }
    for (const action of call.actions ?? []) {
      actionTypes.push(action.type ?? "unknown");
      if (action.type === "screenshot") continue;
      if (action.type === "click" && Number.isInteger(action.x) && Number.isInteger(action.y) &&
        action.x! >= 0 && action.x! < 800 && action.y! >= 0 && action.y! < 600 &&
        (!action.button || action.button === "left")) {
        await page.mouse.click(action.x!, action.y!);
        continue;
      }
      throw new Error(`Unsupported action in native probe: ${action.type ?? "unknown"}.`);
    }
    payload = await send({
      model: "muse-spark-1.3-contributor",
      tools: [{ type: "computer" }],
      previous_response_id: payload.id,
      input: [{ type: "computer_call_output", call_id: call.call_id,
        acknowledged_safety_checks: checks,
        output: { type: "computer_screenshot", image_url: await screenshot() } }]
    });
  }
  const clicked = await page.locator("#filters").getAttribute("data-clicked") === "true";
  console.log(JSON.stringify({
    clicked,
    steps,
    status: payload.status,
    outputTypes: payload.output?.map((item) => item.type),
    actionTypes
  }));
  if (!clicked) throw new Error("Native computer tool did not click the fixture button.");
} finally {
  await browser.close();
}
