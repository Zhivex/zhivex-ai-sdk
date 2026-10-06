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

`environment.viewport` supplies the screenshot's pixel width and height. `environment.screenshot()` returns a PNG, JPEG, or WebP base64 data URL. `environment.execute(actions)` applies actions to that same session, in order. Accepted actions are `click_element`, `type_element`, `click`, `double_click`, `move`, `drag`, `scroll`, `keypress`, `type`, and `screenshot`. An optional `environment.elements()` returns visible `{ id, role, label }` controls; IDs must stay stable during the run, and the environment must resolve them to those controls. Set `environment.elementActionsOnly: true` when that list covers every interactive control; the tool then exposes only element actions and screenshots. The runner rejects element IDs absent from the current visible list and pixel coordinates outside the viewport before execution, then returns feedback so the model can retry. It also reports when a screenshot has not changed and stops after three identical ineffective batches. Optionally pass `isComplete` to verify the application state after each batch and before accepting a text-only final answer. A failed terminal check rejects the run. The application should preserve the viewport size during a run, isolate the session, and check the final UI state. An application-denied batch stops without executing it. `maxSteps` defaults to 12; `maxActionsPerStep` defaults to 4.

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

## Cancellation, approval and completion

The source implementation bounds each environment callback, approval, completion check
and model call with `callbackTimeoutMs` (default 60 seconds). Existing callbacks
that accept no context remain compatible. New callbacks receive `context.signal`,
`context.deadline`, and, for action callbacks, `context.toolCallId` and an immutable
`context.observation` containing the validated screenshot and viewport. Forward
the signal to your driver. Authorization and execution receive the same frozen
batch; nested action data cannot be changed after approval. The executor must
recheck the live session, origin, frame and viewport against that observation
immediately before the effect. The SDK cannot make UI observation and input atomic.

`isComplete` runs after action batches and before accepting a text-only final answer.
A false terminal check rejects the run. Without this callback, returned text is
only the model's report; verify the final UI independently. Duplicate executed call
IDs are rejected within one portable invocation.

`ComputerUseExecutionError` means an action or its following observation failed:
`outcome` is `unknown`, `effectsPossible` is true and `retryable` is false. The error
contains the call ID and immutable proposed actions, which may contain sensitive
text. A timeout stops waiting but cannot physically stop an uncooperative driver
or undo a click. Reconcile the session before starting another run. This portable
runner has no durable journal or resume protocol and makes no exactly-once claim.
Screenshots are format/size checked, not decoded or checked against real dimensions;
the host owns pixel masking, coordinate transforms and transcript retention.

## Native provider boundaries

OpenAI Responses GA has a separate application-owned executor through
`openAIComputerTool`. It supports ordered `click`, `double_click`, `move`, `drag`,
`scroll`, `keypress`, `type`, `wait` and `screenshot` actions. Empty batches, unknown
action shapes and duplicate safety IDs fail closed. Each input preserves `call_id`
and `pending_safety_checks`. Generic tool approval remains required by default.
When provider safety checks are present, additionally supply
`approveSafetyChecks(input, context)` and return true only after confirming every
warning for that exact immutable call. The helper then returns those same checks
as `acknowledged_safety_checks` beside the correlated native screenshot result.
It never infers provider safety approval from generic tool approval.

Both callbacks receive an abort signal and deadline; `callbackTimeoutMs` defaults
to 60 seconds. The executor must apply actions in order and return a PNG/JPEG/WebP
data URL or HTTPS screenshot URL for the same session (maximum 12 MiB URL string;
image contents and dimensions are not decoded/verified). The helper forces image
`detail: "original"`. Failed, cancelled or timed-out execution has an unknown
external outcome and must be reconciled before retrying. Reusing an already
started native call ID within one generation invocation or its supplied continuation
history is rejected. Independent invocations can reuse a long-lived helper and
provider IDs. Replay sets are weakly held by an internal invocation identity rather
than retained for the helper's lifetime. Direct helper calls without a generation
context only reject overlapping calls with the same ID; an execution timeout keeps
that guard until the underlying executor actually settles. This is not a durable
replay ledger; use the Agent journal and an application reconciliation process for
persistent runs. Ordinary functions named `computer` do not acquire native execution
privileges. Native calls without a registered executor remain pending tool calls
and fail the generic tool loop rather than being treated as completed UI work.

OpenAI preview and Azure preview remain manual protocol integrations. Anthropic
computer/browser toolsets preserve native namespaces but require application
member dispatch and screenshot results. Gemini/Vertex GenerateContent declarations
and Interactions transport likewise require an application native controller;
there is no universal native executor or provider parity. A provider capability
flag describes protocol support, not a browser/OS driver or successful UI action.
The portable vision-plus-functions runner can use a compatible model from those
providers independently of their native computer protocol. No SDK creates or
controls an OS session on the application's behalf.
