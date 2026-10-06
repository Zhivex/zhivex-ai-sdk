import { describe, expect, it, vi } from "vitest";

import { runComputerUse } from "../src/index.js";
import { ComputerUseExecutionError } from "../src/computer-use.js";
import type { ComputerAction, ComputerUseCallbackContext, ComputerUseEnvironment } from "../src/computer-use.js";
import { createChatCompletionsModel } from "../src/chat-completions.js";
import type { LanguageModel, ModelGenerateInput } from "../src/index.js";

const screenshot = "data:image/png;base64,iVBORw0KGgo=";
const model = (generate: LanguageModel["generate"]): LanguageModel => ({
  provider: "small-model",
  modelId: "vision-tools",
  capabilities: {
    streaming: false, tools: true, structuredOutput: false, jsonMode: false,
    toolChoice: true, parallelToolCalls: false, vision: true, files: false,
    audioInput: false, audioOutput: false, embeddings: false, reasoning: false, webSearch: false
  },
  generate
});

describe("portable computer use", () => {
  it.each([false, true])("runs the shared transport with explicit tool-choice support: %s", async (toolChoice) => {
    const send = vi.fn()
      .mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "tool_calls", message: {
        content: null, tool_calls: [{ id: "call-1", type: "function", function: {
          name: "computer_action", arguments: JSON.stringify({ actions: [{ type: "click", x: 12, y: 34 }] })
        } }]
      } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "stop", message: { content: "Done" } }] }));
    const testModel = createChatCompletionsModel({
      provider: "fixture", modelId: "vision-tools", capabilities: { ...model(async () => ({})).capabilities, toolChoice }, send
    });
    const execute = vi.fn(async () => {});
    const result = await runComputerUse({ model: testModel, prompt: "Open the panel", authorize: () => true,
      environment: { viewport: { width: 800, height: 600 }, execute, screenshot: async () => screenshot }
    });
    expect(result.text).toBe("Done");
    expect(result.steps).toBe(2);
    expect(execute).toHaveBeenCalledExactlyOnceWith([{ type: "click", x: 12, y: 34 }], expect.objectContaining({ signal: expect.any(AbortSignal), toolCallId: "call-1" }));
    expect(send).toHaveBeenCalledTimes(2);
    for (const [body] of send.mock.calls) {
      if (toolChoice) expect(body.tool_choice).toBe("auto");
      else expect(body).not.toHaveProperty("tool_choice");
    }
  });

  it("sends screenshots as images and executes an authorized batch before continuing", async () => {
    const requests: ModelGenerateInput[] = [];
    const execute = vi.fn(async () => {});
    const authorize = vi.fn(() => true);
    const testModel = model(async (request) => {
      requests.push(request);
      return requests.length === 1
        ? { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "call-1", name: "computer_action", input: { actions: [{ type: "click", x: 12, y: 34 }] } } }] }] }
        : { messages: [{ role: "assistant", parts: [{ type: "text", text: "Done" }] }], text: "Done" };
    });
    const result = await runComputerUse({
      model: testModel, prompt: "Open the panel", environment: { viewport: { width: 800, height: 600 }, execute, screenshot: async () => screenshot }, authorize
    });

    expect(result.text).toBe("Done");
    expect(result.steps).toBe(2);
    expect(authorize).toHaveBeenCalledWith([{ type: "click", x: 12, y: 34 }], expect.objectContaining({ signal: expect.any(AbortSignal), toolCallId: "call-1" }));
    expect(execute).toHaveBeenCalledWith([{ type: "click", x: 12, y: 34 }], expect.objectContaining({ signal: expect.any(AbortSignal), toolCallId: "call-1" }));
    expect(requests[0]?.messages.at(-1)?.parts).toContainEqual({ type: "image", image: screenshot });
    expect(requests[1]?.messages.at(-1)?.parts).toContainEqual({ type: "image", image: screenshot });
    expect(requests[1]?.messages.some((message) => message.role === "tool" && message.parts[0]?.type === "tool-result")).toBe(true);
  });

  it("never executes rejected, malformed, or excessive actions", async () => {
    const execute = vi.fn(async () => {});
    const environment = { viewport: { width: 800, height: 600 }, execute, screenshot: async () => screenshot };
    const response = (actions: unknown) => model(async () => ({ messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "call-1", name: "computer_action", input: { actions } } }] }] }));

    await expect(runComputerUse({ model: response([{ type: "click", x: -1, y: 2 }]), prompt: "Click", environment, authorize: () => true })).rejects.toThrow("invalid computer actions");
    await expect(runComputerUse({ model: response([{ type: "type", text: "secret" }]), prompt: "Type", environment, authorize: () => false })).rejects.toThrow("denied");
    await expect(runComputerUse({ model: response([{ type: "click", x: 1, y: 2 }, { type: "click", x: 3, y: 4 }]), prompt: "Click", environment, authorize: () => true, maxActionsPerStep: 1 })).rejects.toThrow("invalid computer actions");
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires both vision and tools and bounds the loop", async () => {
    const execute = vi.fn(async () => {});
    const environment = { viewport: { width: 800, height: 600 }, execute, screenshot: async () => screenshot };
    const textOnly = model(async () => ({ text: "done" }));
    await expect(runComputerUse({ model: { ...textOnly, capabilities: { ...textOnly.capabilities, vision: false } }, prompt: "Look", environment, authorize: () => true })).rejects.toThrow("requires vision");
    await expect(runComputerUse({ model: model(async () => ({ messages: [{ role: "assistant", parts: [] }] })), prompt: "Look", environment, authorize: () => true })).rejects.toThrow("without a final answer");
    await expect(runComputerUse({ model: model(async () => ({ messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "call-1", name: "computer_action", input: { actions: [{ type: "screenshot" }] } } }] }] })), prompt: "Look", environment, authorize: () => true, maxSteps: 1 })).rejects.toThrow("exceeded maxSteps");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects out-of-bounds pixels and unavailable IDs before authorization, then accepts a visible element", async () => {
    const execute = vi.fn(async () => {});
    const authorize = vi.fn(() => true);
    const requests: ModelGenerateInput[] = [];
    const actions = [
      [{ type: "click", x: 20, y: 600 }],
      [{ type: "click_element", id: "hidden" }],
      [{ type: "click_element", id: "filters" }]
    ];
    const testModel = model(async (request) => {
      requests.push(request);
      const action = actions[requests.length - 1];
      return action
        ? { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: `call-${requests.length}`, name: "computer_action", input: { actions: action } } }] }] }
        : { text: "done" };
    });
    await runComputerUse({
      model: testModel, prompt: "Open filters", authorize,
      environment: { viewport: { width: 800, height: 600 }, execute, screenshot: async () => screenshot, elements: async () => [{ id: "filters", role: "button", label: "Show filters" }] }
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith([{ type: "click_element", id: "filters" }], expect.objectContaining({ toolCallId: "call-3" }));
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(requests[1]?.messages.some((message) => message.role === "tool" && message.parts[0]?.type === "tool-result" && message.parts[0].toolResult.isError)).toBe(true);
    expect(requests[0]?.messages.at(-1)?.parts[0]).toMatchObject({ type: "text", text: expect.stringContaining('"id":"filters"') });
  });

  it("reports unchanged screenshots and stops a repeated no-op action", async () => {
    const execute = vi.fn(async () => {});
    const requests: ModelGenerateInput[] = [];
    const testModel = model(async (request) => {
      requests.push(request);
      return { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: `call-${requests.length}`, name: "computer_action", input: { actions: [{ type: "click", x: 10, y: 20 }] } } }] }] };
    });
    await expect(runComputerUse({ model: testModel, prompt: "Click", authorize: () => true, environment: { viewport: { width: 800, height: 600 }, execute, screenshot: async () => screenshot } })).rejects.toThrow("repeated the same action three times");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(requests[1]?.messages.some((message) => message.role === "tool" && message.parts[0]?.type === "tool-result" && JSON.stringify(message.parts[0].toolResult.output).includes("no_visible_change"))).toBe(true);
  });

  it("offers only visible element actions when the environment opts into element-only mode", async () => {
    const execute = vi.fn(async () => {});
    const requests: ModelGenerateInput[] = [];
    const testModel = model(async (request) => {
      requests.push(request);
      return requests.length === 1
        ? { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "call-1", name: "computer_action", input: { actions: [{ type: "type_element", id: "search", text: "penguin" }] } } }] }] }
        : { text: "done" };
    });
    await runComputerUse({
      model: testModel, prompt: "Search", authorize: () => true,
      environment: { viewport: { width: 800, height: 600 }, elementActionsOnly: true, execute, screenshot: async () => screenshot, elements: async () => [{ id: "search", role: "textbox", label: "Search products" }] }
    });
    expect(execute).toHaveBeenCalledWith([{ type: "type_element", id: "search", text: "penguin" }], expect.objectContaining({ toolCallId: "call-1" }));
    expect(JSON.stringify(requests[0]?.tools)).toContain("type_element");
    expect(JSON.stringify(requests[0]?.tools)).not.toContain('"click"');
  });

  it("returns as soon as the application verifies completion", async () => {
    const generate = vi.fn(async () => ({ messages: [{ role: "assistant" as const, parts: [{ type: "tool-call" as const, toolCall: { id: "call-1", name: "computer_action", input: { actions: [{ type: "screenshot" }] } } }] }] }));
    const isComplete = vi.fn(() => true);
    const result = await runComputerUse({
      model: model(generate), prompt: "Inspect", authorize: () => true, isComplete,
      environment: { viewport: { width: 800, height: 600 }, execute: async () => {}, screenshot: async () => screenshot }
    });
    expect(result.steps).toBe(1);
    expect(result.text).toContain("verified by the application");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(isComplete).toHaveBeenCalledTimes(1);
  });
});


describe("portable computer use execution boundaries", () => {
  const actions: ComputerAction[] = [{ type: "keypress", keys: ["Enter"] }, { type: "click", x: 1, y: 2 }];
  const actionModel = (generate = vi.fn(async () => ({ message: { role: "assistant" as const, parts: [{ type: "tool-call" as const, toolCall: { id: "batch-1", name: "computer_action", input: { actions } } }] } }))) => model(generate);
  const environment = (): ComputerUseEnvironment => ({ viewport: { width: 800, height: 600 }, execute: vi.fn(async () => {}), screenshot: vi.fn(async () => screenshot) });

  it.each([true, false])("consults completion verification on text-only output: %s", async (complete) => {
    const isComplete = vi.fn(() => complete);
    const result = runComputerUse({ model: model(async () => ({ text: "Done" })), prompt: "Do work", environment: environment(), authorize: () => true, isComplete });
    if (complete) expect((await result).text).toBe("Done");
    else await expect(result).rejects.toThrow("did not verify success");
    expect(isComplete).toHaveBeenCalledOnce();
  });

  it("freezes approval inputs and binds execution to the observed viewport and tool ID", async () => {
    const env = environment();
    let approved: readonly ComputerAction[] | undefined;
    let approvedObservation: ComputerUseCallbackContext["observation"];
    await runComputerUse({ model: actionModel(), prompt: "Click", environment: env, isComplete: () => true, authorize: (batch, context) => {
      approved = batch;
      approvedObservation = context.observation;
      expect(Object.isFrozen(batch)).toBe(true);
      expect(Object.isFrozen(batch[0])).toBe(true);
      expect(batch[0]?.type === "keypress" && Object.isFrozen(batch[0].keys)).toBe(true);
      expect(() => { (batch[1] as { x: number }).x = 9000; }).toThrow();
      env.viewport.width = 9999;
      return true;
    } });
    expect(env.execute).toHaveBeenCalledExactlyOnceWith(approved, expect.objectContaining({ toolCallId: "batch-1", observation: approvedObservation }));
    expect(approvedObservation?.viewport.width).toBe(800);
  });

  it("rejects replayed call IDs before executing again", async () => {
    const env = environment();
    await expect(runComputerUse({ model: actionModel(), prompt: "Click", environment: env, authorize: () => true })).rejects.toThrow("cannot replay");
    expect(env.execute).toHaveBeenCalledOnce();
  });

  it("rejects missing executors before observing or calling the model", async () => {
    const env = environment();
    delete (env as Partial<ComputerUseEnvironment>).execute;
    await expect(runComputerUse({ model: actionModel(), prompt: "Click", environment: env, authorize: () => true })).rejects.toThrow("application-owned");
    expect(env.screenshot).not.toHaveBeenCalled();
  });

  it.each(["screenshot", "elements", "authorize", "execute", "isComplete", "model"] as const)("bounds an uncooperative %s callback and cancels its context", async (stage) => {
    const env = environment();
    let context: ComputerUseCallbackContext | undefined;
    const stuck = (value: ComputerUseCallbackContext) => { context = value; return new Promise<never>(() => {}); };
    if (stage === "screenshot") env.screenshot = stuck;
    if (stage === "elements") env.elements = stuck;
    if (stage === "execute") env.execute = (_actions, value) => stuck(value);
    const run = runComputerUse({ model: stage === "model" ? model(async (input) => { context = { signal: input.abortSignal!, deadline: 0 }; return new Promise<never>(() => {}); }) : actionModel(), prompt: "Click", environment: env,
      authorize: stage === "authorize" ? (_actions, value) => stuck(value) : () => true,
      isComplete: stage === "isComplete" ? stuck : () => true, callbackTimeoutMs: 10 });
    if (stage === "execute") await expect(run).rejects.toMatchObject({ outcome: "unknown", effectsPossible: true, retryable: false, toolCallId: "batch-1" });
    else await expect(run).rejects.toMatchObject({ name: "TimeoutError" });
    expect(context?.signal.aborted).toBe(true);
  });

  it.each(["screenshot", "elements", "authorize", "execute", "isComplete", "model"] as const)("aborts during %s without waiting for callback settlement", async (stage) => {
    const env = environment();
    const controller = new AbortController();
    const reason = new Error("cancelled by application");
    const stuck = () => { controller.abort(reason); return new Promise<never>(() => {}); };
    if (stage === "screenshot") env.screenshot = stuck;
    if (stage === "elements") env.elements = stuck;
    if (stage === "execute") env.execute = stuck;
    const run = runComputerUse({ model: stage === "model" ? model(stuck) : actionModel(), prompt: "Click", environment: env, signal: controller.signal,
      authorize: stage === "authorize" ? stuck : () => true, isComplete: stage === "isComplete" ? stuck : () => true });
    if (stage === "execute") await expect(run).rejects.toMatchObject({ cause: reason, outcome: "unknown" });
    else await expect(run).rejects.toBe(reason);
  });

  it("preserves unknown outcome after an effect followed by failed observation and does not retry", async () => {
    const env = environment();
    env.screenshot = vi.fn().mockResolvedValueOnce(screenshot).mockRejectedValueOnce(new Error("capture failed"));
    const generate = vi.fn(actionModel().generate);
    const failure = await runComputerUse({ model: model(generate), prompt: "Click", environment: env, authorize: () => true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ComputerUseExecutionError);
    expect(failure).toMatchObject({ toolCallId: "batch-1", actions, outcome: "unknown", retryable: false });
    expect(env.execute).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("does not resume the loop when a timed-out executor settles late", async () => {
    const env = environment();
    let settle!: () => void;
    env.execute = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    const generate = vi.fn(actionModel().generate);
    await expect(runComputerUse({ model: model(generate), prompt: "Click", environment: env, authorize: () => true, callbackTimeoutMs: 10 })).rejects.toMatchObject({ outcome: "unknown" });
    settle();
    await Promise.resolve();
    expect(env.execute).toHaveBeenCalledOnce();
    expect(env.screenshot).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
  });
});
