import { chromium } from "@playwright/test";
import { runComputerUse, type ComputerAction } from "../packages/sdk/dist/index.js";
import { createQwen } from "../packages/qwen/dist/index.js";
import { createMeta } from "../packages/meta/dist/index.js";
import { createOllama } from "../packages/ollama/dist/index.js";
import { createDeepSeek } from "../packages/deepseek/dist/index.js";

const useMeta = process.env.COMPUTER_USE_PROVIDER === "meta";
const useOllama = process.env.COMPUTER_USE_PROVIDER === "ollama";
const useDeepSeek = process.env.COMPUTER_USE_PROVIDER === "deepseek";
const apiKey = useMeta ? process.env.MODEL_API_KEY : useDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.QWEN_API_KEY;
if (!useOllama && !apiKey) throw new Error(`Set ${useMeta ? "MODEL_API_KEY" : useDeepSeek ? "DEEPSEEK_API_KEY" : "QWEN_API_KEY"} before running this example.`);
const model = useOllama
  ? createOllama()(process.env.COMPUTER_USE_MODEL ?? "gemma4:e4b")
  : useMeta
    ? createMeta({ apiKey: apiKey! })("muse-spark-1.3-contributor")
    : useDeepSeek
      ? createDeepSeek({ apiKey: apiKey! })("deepseek-flash")
      : createQwen({ apiKey: apiKey! })("qwen3.8-flash");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><title>Computer use fixture</title>
    <style>body{font:24px sans-serif;padding:24px}button,input{font:inherit;padding:14px}button{position:absolute;left:40px;top:140px;width:280px;height:100px}section{position:absolute;left:40px;top:280px}input{width:320px;height:80px}</style></head>
    <body><h1>Product search</h1><button id="filters" onclick="document.querySelector('#panel').hidden=false">Show filters</button>
    <section id="panel" hidden><label>Search <input id="search" aria-label="Search products"></label></section></body></html>`);

  const execute = async (actions: readonly ComputerAction[]) => {
    console.log("Computer actions:", JSON.stringify(actions));
    for (const action of actions) {
      switch (action.type) {
        case "click_element": await page.locator(`[id="${action.id}"]`).click(); break;
        case "type_element": await page.locator(`[id="${action.id}"]`).fill(action.text); break;
        case "click": await page.mouse.click(action.x, action.y, { button: action.button ?? "left" }); break;
        case "double_click": await page.mouse.dblclick(action.x, action.y); break;
        case "move": await page.mouse.move(action.x, action.y); break;
        case "drag":
          await page.mouse.move(action.fromX, action.fromY);
          await page.mouse.down();
          await page.mouse.move(action.toX, action.toY);
          await page.mouse.up();
          break;
        case "scroll": await page.mouse.move(action.x, action.y); await page.mouse.wheel(action.deltaX, action.deltaY); break;
        case "keypress": {
          const keyAliases: Record<string, string> = { return: "Enter", enter: "Enter", tab: "Tab", esc: "Escape", ctrl: "Control", cmd: "Meta" };
          await page.keyboard.press(action.keys.map((key) => keyAliases[key.toLowerCase()] ?? key).join("+"));
          break;
        }
        case "type": await page.keyboard.insertText(action.text); break;
        case "screenshot": break;
      }
    }
  };

  const result = await runComputerUse({
    model,
    prompt: "Open the filters panel and type penguin in the Search products field. Check the result before finishing.",
    environment: {
      viewport: { width: 800, height: 600 },
      elementActionsOnly: true,
      execute,
      screenshot: async () => `data:image/png;base64,${(await page.screenshot()).toString("base64")}`,
      elements: async () => [
        { id: "filters", role: "button", label: "Show filters" },
        ...(await page.locator("#search").isVisible() ? [{ id: "search", role: "textbox", label: "Search products" }] : [])
      ]
    },
    // This fixture is isolated; restrict a real environment to approved sites and actions.
    authorize: () => true,
    isComplete: async () => await page.locator("#panel").isVisible() && await page.locator("#search").inputValue() === "penguin",
    maxSteps: 12,
    maxActionsPerStep: 3
  });

  const panelOpen = await page.locator("#panel").isVisible();
  const searchValue = await page.locator("#search").inputValue();
  if (!panelOpen || searchValue !== "penguin") {
    throw new Error(`Computer use did not complete the fixture (panelOpen=${panelOpen}, searchValue=${JSON.stringify(searchValue)}).`);
  }
  console.log(JSON.stringify({ ok: true, steps: result.steps, answer: result.text }));
} finally {
  await browser.close();
}
