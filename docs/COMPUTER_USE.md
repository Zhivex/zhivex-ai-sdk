# Portable computer use

`runComputerUse()` is an experimental API that lets a model with image input and callable tools operate an application-owned browser or desktop session. It uses ordinary `computer_action` function calls, so the model does not need a provider-native computer tool. OpenAI's native `openAIComputerTool()` remains available separately.

Import the runner and its supporting types from `@zhivex-ai/sdk/experimental` or
`@zhivex-ai/core/experimental`. The root exports remain available. Models need
vision and callable tools; explicit tool-choice support is optional. The runner
omits `toolChoice` when the model does not support that option.

The application owns the environment: keep one browser or desktop session alive, provide its viewport size, execute each ordered action batch, and return a screenshot of that same session. The SDK sends the screenshot as an image in the next model request. `authorize` is required for every valid action batch. The SDK validates actions and applies step and batch limits; the application must enforce its own allowed sites and consequential-action policy.

```ts
import { runComputerUse, type ComputerUseEnvironment } from "@zhivex-ai/sdk/experimental";
import { createQwen } from "@zhivex-ai/qwen";

// Connect these methods to a persistent browser or desktop session in your app.
declare const environment: ComputerUseEnvironment;

const qwen = createQwen({ apiKey: process.env.QWEN_API_KEY });
const result = await runComputerUse({
  model: qwen("qwen3.8-flash"),
  prompt: "Open the filters panel and tell me which filters are available.",
  environment,
  maxSteps: 8,
  maxActionsPerStep: 3,
  authorize: async (actions) => {
    // Replace this example with your site's allowlist and user approval flow.
    return actions.every((action) => action.type === "screenshot" || action.type === "click");
  }
});

console.log(result.text, result.steps);
```

`environment.viewport` supplies the screenshot's pixel width and height. `environment.screenshot()` returns a PNG, JPEG, or WebP base64 data URL. `environment.execute(actions)` applies actions to that same session, in order. Accepted actions are `click_element`, `type_element`, `click`, `double_click`, `move`, `drag`, `scroll`, `keypress`, `type`, and `screenshot`. An optional `environment.elements()` returns visible `{ id, role, label }` controls; IDs must stay stable during the run, and the environment must resolve them to those controls. Set `environment.elementActionsOnly: true` when that list covers every interactive control; the tool then exposes only element actions and screenshots. The runner rejects element IDs absent from the current visible list and pixel coordinates outside the viewport before execution, then returns feedback so the model can retry. It also reports when a screenshot has not changed and stops after three identical ineffective batches. Optionally pass `isComplete` to verify the application state after each batch and return immediately when the objective is met, even if the model does not produce a final answer. The application should preserve the viewport size during a run, isolate the session, and check the final UI state. An application-denied batch stops without executing it. `maxSteps` defaults to 12; `maxActionsPerStep` defaults to 4.

Qwen 3.8 Flash is a useful initial candidate because its SDK route supports image input and callable tools. Other routes, including a Gemma 4 model served through Ollama, can use the same runner when their actual host supports both features. Local contract tests cover Qwen request mapping; a real browser run still requires an application environment and live model credentials.

For a complete local browser fixture that verifies the resulting UI state, run:

```bash
bun run build
bunx playwright install chromium
QWEN_API_KEY=... bun run examples/computer-use-qwen.ts
```

The [example](../examples/computer-use-qwen.ts) uses an isolated page with a filters panel and search field. It does not open external sites. It fails if the panel is closed or the search value differs from `penguin`.

To run the same portable fixture with Muse Spark 1.3 Contributor, set `MODEL_API_KEY` and run `COMPUTER_USE_PROVIDER=meta bun run examples/computer-use-qwen.ts`. Meta also provides a native Responses `computer` tool. The SDK Meta adapter does not yet implement that native protocol; the [direct Meta probe](../examples/meta-native-computer-probe.ts) tests it on an isolated page and verifies the click in the DOM.

For DeepSeek Flash, set `DEEPSEEK_API_KEY` and run `COMPUTER_USE_PROVIDER=deepseek bun run examples/computer-use-qwen.ts`.

For a local Ollama model, start Ollama with `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`, pull a model that supports images and tool calls, then run `COMPUTER_USE_PROVIDER=ollama COMPUTER_USE_MODEL=gemma4:e4b bun run examples/computer-use-qwen.ts`. You can substitute `qwen3.5:4b`. Ollama's 4K default context on some machines can be too small for repeated screenshots. The fixture checks the DOM after the model finishes, so a plausible text answer alone does not count as success. Vision and function-call support alone do not guarantee accurate pixel coordinates, especially for small local models.
