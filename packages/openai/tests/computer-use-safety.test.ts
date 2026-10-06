import { describe, expect, it, vi } from "vitest";
import { createAgent, createInMemoryAgentRunStore, generateText, streamText, runAgent, streamAgent } from "@zhivex-ai/core";
import { createOpenAI, openAIComputerTool, type OpenAIComputerToolConfig, openAIComputerUseTool } from "../src/index.js";

const screenshot = { type: "computer_screenshot" as const, image_url: "data:image/png;base64,aGVsbG8=" };
const checks = [{ id: "safety-1", code: "sensitive_domain", message: "Confirm this domain" }];
const actions = [{ type: "click", x: 10, y: 20 }, { type: "screenshot" }];
const input = () => ({ call_id: "call-computer-1", actions: structuredClone(actions), pending_safety_checks: structuredClone(checks) });

function fixture(call: Record<string, unknown>) {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ id: "response-1", status: "completed", output: [{ type: "computer_call", ...call }] }))
    .mockResolvedValueOnce(Response.json({ id: "response-2", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }] }));
  const model = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("gpt-5.6-luna");
  return { fetchMock, model };
}

describe("OpenAI native computer safety boundary", () => {
  it("preserves the approved batch, safety identifiers and correlated screenshot on the wire", async () => {
    const { model, fetchMock } = fixture(input());
    const approveSafetyChecks = vi.fn(() => true);
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    const result = await generateText({ model, prompt: "click", maxSteps: 2, toolApprovalPolicy: () => true,
      tools: { computer: openAIComputerTool({ approveSafetyChecks, execute }) } });
    expect(result.text).toBe("Done");
    expect(approveSafetyChecks).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual(input());
    expect(execute.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1].body));
    expect(body.input).toEqual([{ type: "computer_call_output", call_id: "call-computer-1",
      acknowledged_safety_checks: checks, output: { ...screenshot, detail: "original" } }]);
  });

  it.each(["absent", "denied"])("does not execute or continue when safety approval is %s", async (mode) => {
    const { model, fetchMock } = fixture(input());
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    await expect(generateText({ model, prompt: "click", maxSteps: 2, toolApprovalPolicy: () => true,
      tools: { computer: openAIComputerTool({ execute, ...(mode === "denied" ? { approveSafetyChecks: () => false } : {}) }) }
    })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still applies the app's general deny policy before safety approval", async () => {
    const { model } = fixture(input());
    const approveSafetyChecks = vi.fn(() => true);
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    await expect(generateText({ model, prompt: "click", maxSteps: 1, toolApprovalPolicy: () => false,
      tools: { computer: openAIComputerTool({ execute, approveSafetyChecks }) } })).rejects.toThrow(/denied/i);
    expect(execute).not.toHaveBeenCalled();
    expect(approveSafetyChecks).not.toHaveBeenCalled();
  });

  it("does not ask for safety approval when the provider has no pending checks", async () => {
    const approveSafetyChecks = vi.fn(() => false);
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    await openAIComputerTool({ approveSafetyChecks, execute }).execute({ actions });
    expect(approveSafetyChecks).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("prevents an approval callback from changing the approved action or safety ID", async () => {
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    const nativeTool = openAIComputerTool({ execute, approveSafetyChecks: (proposal) => {
      expect(Reflect.set(proposal.pending_safety_checks![0]!, "id", "forged")).toBe(false);
      expect(Reflect.set(proposal.actions[0] as object, "x", 999)).toBe(false);
      return true;
    } });
    await nativeTool.execute(input());
    expect(execute.mock.calls[0]?.[0]).toEqual(input());
  });

  it.each([[], [{ type: "unknown_action" }], [{ type: "click", x: -1, y: 20 }], [{ type: "click", x: 10 }]].map((actions) => ({ actions })))(
    "rejects invalid action batches before execution: %j", async ({ actions: invalidActions }) => {
      const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
      await expect(openAIComputerTool({ execute }).execute({ actions: invalidActions })).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it("times out a pending approval without invoking the executor", async () => {
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    const nativeTool = openAIComputerTool({ execute, callbackTimeoutMs: 10, approveSafetyChecks: () => new Promise(() => {}) });
    await expect(nativeTool.execute(input())).rejects.toThrow(/timed out|timeout/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not retry an executor that times out after a possible effect", async () => {
    let signal: AbortSignal | undefined;
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>((_proposal, context) => { signal = context?.abortSignal; return new Promise<typeof screenshot>(() => {}); });
    const nativeTool = openAIComputerTool({ execute, callbackTimeoutMs: 10 });
    await expect(nativeTool.execute({ actions, call_id: "call-computer-1" })).rejects.toMatchObject({ outcome: "unknown", effectsPossible: true, cause: expect.objectContaining({ message: "Computer callback timed out." }) });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
  });

  it("cancels an approval wait before the executor starts", async () => {
    const { model, fetchMock } = fixture(input());
    const controller = new AbortController();
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    const approveSafetyChecks = vi.fn(() => {
      queueMicrotask(() => controller.abort(new Error("approval canceled")));
      return new Promise<boolean>(() => {});
    });
    await expect(generateText({ model, prompt: "click", abortSignal: controller.signal,
      maxSteps: 2, toolApprovalPolicy: () => true,
      tools: { computer: openAIComputerTool({ execute, approveSafetyChecks }) }
    })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight executor without retrying or reporting a screenshot", async () => {
    const { model, fetchMock } = fixture({ call_id: "call-computer-1", actions });
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>((_proposal, context) => {
      signal = context?.abortSignal;
      queueMicrotask(() => controller.abort(new Error("execution canceled")));
      return new Promise<typeof screenshot>(() => {});
    });
    await expect(generateText({ model, prompt: "click", abortSignal: controller.signal,
      maxSteps: 2, toolApprovalPolicy: () => true, tools: { computer: openAIComputerTool({ execute }) }
    })).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });


  it("preserves safety checks and identity in streaming computer calls", async () => {
    const events = [
      { type: "response.output_item.done", output_index: 0, item: { type: "computer_call", ...input() } },
      { type: "response.completed", response: { id: "response-stream", status: "completed" } }
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" }
    }));
    const model = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("gpt-5.6-luna");
    const received = [];
    for await (const event of await model.stream!({
      messages: [{ role: "user", parts: [{ type: "text", text: "click" }] }],
      tools: { computer: openAIComputerTool({ execute: () => screenshot }) }
    })) received.push(event);
    expect(received.filter((event) => event.type === "tool-call")).toEqual([
      { type: "tool-call", toolCall: { id: "call-computer-1", name: "computer", input: input(), providerMetadata: expect.objectContaining({ responsesToolType: "computer" }) } }
    ]);
  });


  it("rejects a missing app executor at construction", () => {
    expect(() => openAIComputerTool({} as OpenAIComputerToolConfig)).toThrow(/executor/i);
  });

  it("rejects duplicate safety identifiers without approval or execution", async () => {
    const approveSafetyChecks = vi.fn(() => true);
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    await expect(openAIComputerTool({ execute, approveSafetyChecks }).execute({
      ...input(), pending_safety_checks: [checks[0]!, checks[0]!]
    })).rejects.toThrow(/duplicate/i);
    expect(approveSafetyChecks).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects mismatched runtime and provider call identity before execution", async () => {
    const { model } = fixture(input());
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    await expect(openAIComputerTool({ execute }).execute({ actions, call_id: "other-call" }, {
      model, step: 1, toolCall: { id: "call-computer-1", name: "computer", input: {}, providerMetadata: { responsesToolType: "computer" } }
    })).rejects.toThrow(/identity mismatch/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("marks an invalid post-execution screenshot as an unknown outcome", async () => {
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => ({ type: "computer_screenshot", image_url: "not-an-image" }));
    await expect(openAIComputerTool({ execute }).execute({ actions })).rejects.toMatchObject({ outcome: "unknown", effectsPossible: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });


  it("persists an Agent failure after partial effects and never retries its executor", async () => {
    const { model, fetchMock } = fixture({ call_id: "call-computer-1", actions });
    const store = createInMemoryAgentRunStore();
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => { throw new Error("clicked but screenshot failed"); });
    const agent = createAgent({ id: "computer-unknown", model, store,
      toolApprovalPolicy: () => true, tools: { computer: openAIComputerTool({ execute }) } });
    await expect(runAgent(agent, { runId: "computer-unknown-run", prompt: "click", maxSteps: 2 })).rejects.toThrow(/unknown|reconcile/i);
    const persisted = await store.load("computer-unknown-run");
    expect(persisted).toMatchObject({ status: "failed", error: {
      effectsPossible: true, retryable: false, diagnosticCode: "INDETERMINATE_TOOL_EXECUTION"
    } });
    expect(await store.listToolCalls!("computer-unknown-run")).toEqual([
      expect.objectContaining({ status: "running", providerToolCallId: "call-computer-1" })
    ]);
    await expect(runAgent(agent, { runId: "computer-unknown-run" })).rejects.toThrow(/reconcile/i);
    expect(persisted?.outputText).not.toBe("Done");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses an already completed Agent run without replaying its computer effects", async () => {
    const { model, fetchMock } = fixture(input());
    const store = createInMemoryAgentRunStore();
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    const approveSafetyChecks = vi.fn(() => true);
    const agent = createAgent({ id: "computer-replay", model, store, toolApprovalPolicy: () => true,
      tools: { computer: openAIComputerTool({ execute, approveSafetyChecks }) } });
    const first = await runAgent(agent, { prompt: "click", idempotencyKey: "computer-once", maxSteps: 2 });
    const second = await runAgent(agent, { prompt: "click", idempotencyKey: "computer-once", maxSteps: 2 });
    expect(first.status).toBe("completed");
    expect(second.state.runId).toBe(first.state.runId);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(approveSafetyChecks).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      runId: first.state.runId, toolCall: expect.objectContaining({ id: "call-computer-1" }), idempotencyKey: expect.any(String)
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never executes an Agent computer call from an interrupted provider stream", async () => {
    const partial = { type: "response.output_item.done", output_index: 0, item: { type: "computer_call", ...input() } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify(partial)}\n\n`, {
      headers: { "content-type": "text/event-stream" }
    }));
    const model = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("gpt-5.6-luna");
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    const approveSafetyChecks = vi.fn(() => true);
    const agent = createAgent({ id: "computer-partial", model, toolApprovalPolicy: () => true,
      tools: { computer: openAIComputerTool({ execute, approveSafetyChecks }) } });
    await expect(streamAgent(agent, { prompt: "click", maxSteps: 2 }).collect()).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(approveSafetyChecks).not.toHaveBeenCalled();
  });


  it("preserves unknown effects when the generic Agent tool timeout fires first", async () => {
    const { model, fetchMock } = fixture({ call_id: "call-computer-1", actions });
    const store = createInMemoryAgentRunStore();
    let settleExecutor!: (value: typeof screenshot) => void;
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => new Promise((resolve) => { settleExecutor = resolve; }));
    const agent = createAgent({ id: "computer-outer-timeout", model, store, toolApprovalPolicy: () => true,
      toolExecution: { timeoutMs: 10 }, tools: { computer: openAIComputerTool({ execute, callbackTimeoutMs: 1000 }) } });
    await expect(runAgent(agent, { runId: "computer-timeout-run", prompt: "click", maxSteps: 2 })).rejects.toMatchObject({ effectsPossible: true, retryable: false });
    expect(await store.load("computer-timeout-run")).toMatchObject({ status: "failed", error: { effectsPossible: true, retryable: false } });
    settleExecutor(screenshot);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.listToolCalls!("computer-timeout-run")).toEqual([expect.objectContaining({ status: "running" })]);
    await expect(runAgent(agent, { runId: "computer-timeout-run" })).rejects.toThrow(/reconcile/i);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("blocks repeated call IDs across steps within one invocation (stream=%s)", async streaming => {
    let count = 0;
    const fetchMock = vi.fn(async () => {
      const proposal = { type: "computer_call", call_id: "same-call", actions: count++ === 0 ? actions : [{ type: "screenshot" }] };
      const response = { id: `response-${count}`, status: "completed", output: [proposal] };
      return streaming
        ? new Response(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: proposal })}\n\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
        : Response.json(response);
    });
    const model = createOpenAI({ apiKey: "fixture", fetch: fetchMock as typeof fetch })("gpt-6-luna");
    const execute = vi.fn(() => screenshot);
    const options = { model, prompt: "fixture", maxSteps: 3, toolApprovalPolicy: () => true, tools: { computer: openAIComputerTool({ execute }) } };
    const run = async () => {
      if (!streaming) return generateText(options);
      const stream = streamText(options);
      await Array.fromAsync(stream.eventStream);
      return stream.collect();
    };
    await expect(run()).rejects.toThrow(/already started|reconcile/i);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("releases direct helper call IDs after completion", async () => {
    const execute = vi.fn(() => screenshot);
    const nativeTool = openAIComputerTool({ execute });
    await nativeTool.execute({ call_id: "same-call", actions });
    await nativeTool.execute({ call_id: "same-call", actions });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(["GA", "preview"])("does not falsely complete unhandled %s computer work", async (mode) => {
    const call = mode === "GA" ? { call_id: "unhandled", actions } : { call_id: "unhandled", action: { type: "screenshot" } };
    const { model, fetchMock } = fixture(call);
    const tools = mode === "preview" ? { computer: openAIComputerUseTool({ environment: "browser", display_width: 800, display_height: 600 }) } : undefined;
    const store = createInMemoryAgentRunStore();
    const agent = createAgent({ id: "unhandled-computer", model, tools, store });
    await expect(runAgent(agent, { runId: `unhandled-${mode}`, prompt: "click", maxSteps: 2 })).rejects.toThrow();
    expect(await store.load(`unhandled-${mode}`)).toMatchObject({ status: "failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an ordinary function_call spoofing the native computer helper", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ id: "response-spoof", status: "completed", output: [
      { type: "function_call", call_id: "spoof", name: "computer", arguments: JSON.stringify({ actions, call_id: "spoof" }) }
    ] }));
    const model = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("gpt-5.6-luna");
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    await expect(generateText({ model, prompt: "click", maxSteps: 2, toolApprovalPolicy: () => true,
      tools: { computer: openAIComputerTool({ execute }) } })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });


  it("executes a concurrent duplicate approved call at most once", async () => {
    let release!: (value: boolean) => void;
    const approval = new Promise<boolean>((resolve) => { release = resolve; });
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    const nativeTool = openAIComputerTool({ execute, approveSafetyChecks: () => approval });
    const first = nativeTool.execute(input());
    const second = nativeTool.execute(input());
    release(true);
    const settled = await Promise.allSettled([first, second]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["GA", "preview"])("generateText fails closed on unhandled %s actions", async (mode) => {
    const call = mode === "GA" ? { call_id: "unhandled", actions } : { call_id: "unhandled", action: { type: "screenshot" } };
    const { model, fetchMock } = fixture(call);
    const tools = mode === "preview" ? { computer: openAIComputerUseTool({ environment: "browser", display_width: 800, display_height: 600 }) } : undefined;
    await expect(generateText({ model, prompt: "click", tools, maxSteps: 2 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });


  it.each(["rewrite-action", "drop-safety"])("blocks a guardrail that changes the native proposal: %s", async (change) => {
    const { model, fetchMock } = fixture(input());
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    const approveSafetyChecks = vi.fn(() => true);
    const nativeTool = openAIComputerTool({ execute, approveSafetyChecks });
    nativeTool.inputGuardrails = [({ context }) => {
      const proposal = context.toolCall.input as unknown as ReturnType<typeof input>;
      if (change === "drop-safety") proposal.pending_safety_checks = [];
      else proposal.actions = [{ type: "screenshot" }];
    }];
    await expect(generateText({ model, prompt: "click", maxSteps: 1, toolApprovalPolicy: () => true,
      tools: { computer: nativeTool } })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(approveSafetyChecks).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["absent", "denied"])("fails an Agent at maxSteps 1 with %s safety approval", async (approval) => {
    const { model, fetchMock } = fixture(input());
    const store = createInMemoryAgentRunStore();
    const execute = vi.fn<OpenAIComputerToolConfig["execute"]>(() => screenshot);
    const agent = createAgent({ model, store, toolApprovalPolicy: () => true, tools: {
      computer: openAIComputerTool({ execute, ...(approval === "denied" ? { approveSafetyChecks: () => false } : {}) })
    } });
    await expect(runAgent(agent, { runId: `denied-${approval}`, prompt: "click", maxSteps: 1 })).rejects.toThrow();
    expect(await store.load(`denied-${approval}`)).toMatchObject({ status: "failed" });
    expect(execute).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});

it.each(["failed", "incomplete", "cancelled", "in_progress"])("never executes a native computer proposal from a %s response", async status => {
  const fetchMock = vi.fn(async () => Response.json({ id: "nonterminal", status, output: [{ type: "computer_call", ...input() }] }));
  const execute = vi.fn(() => screenshot);
  const model = createOpenAI({ apiKey: "fixture", fetch: fetchMock as typeof fetch })("gpt-6-luna");
  await expect(generateText({ model, prompt: "fixture", maxSteps: 1, maxRetries: 0, toolApprovalPolicy: () => true,
    tools: { computer: openAIComputerTool({ execute, approveSafetyChecks: () => true }) } })).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("does not dispatch a native call to an ordinary function named computer", async () => {
  const { model, fetchMock } = fixture(input());
  const execute = vi.fn(() => screenshot);
  const nativeTool = openAIComputerTool({ execute });
  // An ordinary tool registry entry cannot acquire native privileges by name.
  const ordinaryTool = { ...nativeTool, metadata: undefined, requiresApproval: false };
  await expect(generateText({ model, prompt: "fixture", maxSteps: 1, tools: { computer: ordinaryTool } })).rejects.toThrow(/native computer executor/);
  expect(execute).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});


it.each([false, true])("reuses a long-lived tool across independent same-ID invocations (stream=%s)", async streaming => {
  const execute = vi.fn(() => screenshot);
  const nativeTool = openAIComputerTool({ execute, approveSafetyChecks: () => true });
  for (let index = 0; index < 3; index++) {
    let count = 0;
    const model = createOpenAI({ apiKey: "fixture", fetch: async () => {
      const output = count++ === 0 ? [{ type: "computer_call", ...input() }] : [{ type: "message", content: [{ type: "output_text", text: "Done" }] }];
      const response = { id: `response-${count}`, status: "completed", output };
      return streaming ? new Response(`${output.map((item, output_index) => `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`).join("")}data: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(response);
    } })("gpt-6-luna");
    const options = { model, prompt: "fixture", maxSteps: 2, toolApprovalPolicy: () => true, tools: { computer: nativeTool } };
    if (streaming) {
      const stream = streamText(options);
      await Array.fromAsync(stream.eventStream);
      await stream.collect();
    } else await generateText(options);
  }
  expect(execute).toHaveBeenCalledTimes(3);
});

it("allows concurrent independent invocations sharing a tool and provider call ID", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const execute = vi.fn(async () => { await gate; return screenshot; });
  const nativeTool = openAIComputerTool({ execute, approveSafetyChecks: () => true });
  const invoke = () => generateText({ model: fixture(input()).model, prompt: "fixture", maxSteps: 2,
    toolApprovalPolicy: () => true, tools: { computer: nativeTool } });
  const pending = [invoke(), invoke()];
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  release();
  await Promise.all(pending);
});

it("retains the direct duplicate guard while a timed-out executor is still running", async () => {
  let settle!: (value: typeof screenshot) => void;
  const execute = vi.fn(() => new Promise<typeof screenshot>(resolve => { settle = resolve; }));
  const nativeTool = openAIComputerTool({ callbackTimeoutMs: 10, execute });
  const proposal = { call_id: "late-direct", actions };
  await expect(nativeTool.execute(proposal)).rejects.toMatchObject({ effectsPossible: true });
  await expect(nativeTool.execute(proposal)).rejects.toThrow(/already started/);
  expect(execute).toHaveBeenCalledTimes(1);
  settle(screenshot);
  await new Promise(resolve => setTimeout(resolve, 0));
  execute.mockImplementation(async () => screenshot);
  await nativeTool.execute(proposal);
  expect(execute).toHaveBeenCalledTimes(2);
});

it("rejects a completed native call ID supplied in continuation history", async () => {
  const execute = vi.fn(() => screenshot);
  const nativeTool = openAIComputerTool({ execute, approveSafetyChecks: () => true });
  const first = await generateText({ model: fixture(input()).model, prompt: "fixture", maxSteps: 2,
    toolApprovalPolicy: () => true, tools: { computer: nativeTool } });
  await expect(generateText({ model: fixture(input()).model, messages: first.messages, maxSteps: 2,
    toolApprovalPolicy: () => true, tools: { computer: nativeTool } })).rejects.toThrow(/already started/);
  expect(execute).toHaveBeenCalledTimes(1);
});
