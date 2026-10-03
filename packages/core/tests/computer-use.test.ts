import { describe, expect, it, vi } from "vitest";

import { runComputerUse } from "../src/index.js";
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
    expect(execute).toHaveBeenCalledExactlyOnceWith([{ type: "click", x: 12, y: 34 }]);
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
    expect(authorize).toHaveBeenCalledWith([{ type: "click", x: 12, y: 34 }]);
    expect(execute).toHaveBeenCalledWith([{ type: "click", x: 12, y: 34 }]);
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
    expect(execute).toHaveBeenCalledWith([{ type: "click_element", id: "filters" }]);
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
    expect(execute).toHaveBeenCalledWith([{ type: "type_element", id: "search", text: "penguin" }]);
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
