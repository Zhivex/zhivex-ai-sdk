import { describe, expect, it, vi } from "vitest";
import { Agent, createFileAgentRunStore, tool, type ModelGenerateInput, type ModelMessage } from "@zhivex-ai/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createOpenAI } from "../src/index.js";

const receipt = { schemaVersion: 1, kind: "patch-result", result: { changes: [{ operation: "create", path: "fixture.txt" }], empty: null, ok: false } };
const failure = { message: "synthetic failure", code: "TOOL_INPUT_VALIDATION_ERROR" as const };
const completed = { id: "resp_done", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } };

function fixture(streaming: boolean) {
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => streaming
    ? new Response(`data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    : Response.json(completed));
  const model = createOpenAI({ apiKey: "synthetic-key", fetch: fetcher as typeof fetch })("gpt-6-luna");
  return { fetcher, async run(input: ModelGenerateInput) {
    if (streaming) {
      const events = await Array.fromAsync(await model.stream(input));
      expect(events.some(event => event.type === "finish")).toBe(true);
    } else {
      const result = await model.generate(input);
      expect(result.finishReason).toBe("stop");
      expect(result.usage?.totalTokens).toBe(7);
    }
    return JSON.parse(String(fetcher.mock.calls[0][1]?.body));
  } };
}

function history(name: string, isError: boolean, stored: boolean): ModelMessage[] {
  return [
    { role: "assistant", parts: [
      { type: "tool-call", toolCall: { id: "call_fixture", name, input: { nested: { value: 1 } } } },
      ...(stored ? [{ type: "provider-data" as const, provider: "openai", data: { responseId: "resp_previous" } }] : [])
    ] },
    { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "call_fixture", toolName: name, isError, ...(isError ? { error: failure } : { output: receipt }) } }] }
  ];
}

describe.each([false, true])("Responses tool receipts (stream=%s)", streaming => {
  for (const stored of [false, true]) for (const envelope of [false, true]) for (const isError of [false, true]) {
    it.each(["apply_patch", "shell", "computer", "inspect"])(`preserves %s (stored=${stored}, envelope=${envelope}, error=${isError})`, async name => {
      const messages = history(name, isError, stored);
      const original = structuredClone(messages);
      const { run } = fixture(streaming);
      const body = await run({ messages, providerOptions: { apiMode: "responses", store: stored }, ...(envelope ? { toolResultFormat: "envelope" as const } : {}) });
      const value = isError ? failure : receipt;
      expect(body.input.at(-1)).toEqual({ type: "function_call_output", call_id: "call_fixture", output: JSON.stringify(envelope ? (isError ? { error: value } : { output: value }) : value) });
      if (stored) {
        expect(body.previous_response_id).toBe("resp_previous");
        expect(body.input).toHaveLength(1);
      } else {
        expect(body.previous_response_id).toBeUndefined();
        expect(body.input[0]).toEqual({ type: "function_call", call_id: "call_fixture", name, arguments: JSON.stringify({ nested: { value: 1 } }) });
      }
      expect(messages).toEqual(original);
    });
  }

  it.each([
    ["apply_patch", { status: "completed", output: "patched" }],
    ["shell", [{ stdout: "ok", stderr: "", outcome: { type: "exit", exit_code: 0 } }]],
    ["computer", { type: "computer_screenshot", image_url: "data:image/png;base64,aGVsbG8=" }]
  ] as const)("preserves explicit native %s with envelope too", async (type, output) => {
    const { run } = fixture(streaming);
    const body = await run({ messages: [{ role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "native_call", toolName: "custom_name", isError: false, output: JSON.parse(JSON.stringify(output)), providerMetadata: { responsesToolType: type } } }] }], toolResultFormat: "envelope", providerOptions: { apiMode: "responses" } });
    expect(body.input[0]).toEqual({ type: `${type}_call_output`, call_id: "native_call", ...(type === "apply_patch" ? output : { output }) });
  });

  it("derives native protocol from the original call before stored history is sliced", async () => {
    const messages = history("patcher", false, true);
    const call = messages[0].parts[0];
    const result = messages[1].parts[0];
    if (call.type !== "tool-call" || result.type !== "tool-result") throw new Error("fixture");
    call.toolCall.providerMetadata = { responsesToolType: "apply_patch" };
    result.toolResult.output = { status: "completed", output: "patched" };
    const body = await fixture(streaming).run({ messages });
    expect(body.input).toEqual([{ type: "apply_patch_call_output", call_id: "call_fixture", status: "completed", output: "patched" }]);
  });

  it("preserves multiple receipt IDs and order in one message", async () => {
    const messages = history("apply_patch", false, false);
    const other = history("computer", true, false);
    for (const message of other) for (const part of message.parts) {
      if (part.type === "tool-call") part.toolCall.id = "second_call";
      if (part.type === "tool-result") part.toolResult.toolCallId = "second_call";
    }
    messages[0].parts.push(...other[0].parts);
    messages[1].parts.push(...other[1].parts);
    const body = await fixture(streaming).run({ messages });
    expect(body.input.slice(-2)).toEqual([
      { type: "function_call_output", call_id: "call_fixture", output: JSON.stringify(receipt) },
      { type: "function_call_output", call_id: "second_call", output: JSON.stringify(failure) }
    ]);
  });

  it.each(["wrong-name", "wrong-protocol", "unknown-protocol"])("rejects %s before HTTP without echoing payload", async variant => {
    const messages = history("apply_patch", false, true);
    const part = messages[1].parts[0];
    if (part.type !== "tool-result") throw new Error("fixture");
    if (variant === "wrong-name") part.toolResult.toolName = "sensitive-name";
    else part.toolResult.providerMetadata = { responsesToolType: variant === "wrong-protocol" ? "apply_patch" : "sensitive-type" };
    const { run, fetcher } = fixture(streaming);
    await expect(run({ messages, maxRetries: 0 })).rejects.toThrow("OpenAI Responses tool result has inconsistent call metadata.");
    expect(fetcher).not.toHaveBeenCalled();
  });
});


describe("durable function receipt", () => {
  it.each([false, true])("reopens file store and resumes exactly once (stream=%s)", async streaming => {
    const directory = await mkdtemp(join(tmpdir(), "responses-receipt-"));
    try {
      const requests: any[] = [];
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        const response = requests.length === 1
          ? { id: "resp_approval", status: "completed", output: [{ type: "function_call", id: "item_fixture", status: "completed", call_id: "call_fixture", name: "apply_patch", arguments: "{}" }] }
          : completed;
        return requests.at(-1).stream
          ? new Response(`${response.output.map((item, output_index) => `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`).join("")}data: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
          : Response.json(response);
      });
      const execute = vi.fn(() => receipt);
      const model = createOpenAI({ apiKey: "fixture", fetch: fetcher as typeof fetch })("gpt-6-luna");
      const tools = { apply_patch: tool({ name: "apply_patch", schema: z.object({}), requiresApproval: true, approvalMode: "interrupt", execute }) };
      const firstAgent = new Agent({ model, store: createFileAgentRunStore({ directory }), tools, maxSteps: 3 });
      let first;
      if (streaming) {
        const stream = firstAgent.stream({ prompt: "Synthetic patch." });
        await Array.fromAsync(stream.eventStream);
        first = await stream.collect();
      } else first = await firstAgent.run({ prompt: "Synthetic patch." });
      expect(first.status).toBe("waiting_approval");
      expect(execute).not.toHaveBeenCalled();
      // File stores have no persistent handle: a new instance reloads the on-disk state and journal.
      const reopened = createFileAgentRunStore({ directory });
      const secondAgent = new Agent({ model, store: reopened, tools, maxSteps: 3 });
      const resumeInput = { state: (await reopened.load(first.state.runId))!, approvals: first.state.pendingApprovals.map(approval => ({ provider: approval.provider, approvalRequestId: approval.id, approve: true })) };
      let result;
      if (streaming) {
        const stream = secondAgent.stream(resumeInput);
        await Array.fromAsync(stream.eventStream);
        result = await stream.collect();
      } else result = await secondAgent.resume(resumeInput);
      expect(result.status).toBe("completed");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(requests[1].input).toContainEqual({ type: "function_call_output", call_id: "call_fixture", output: JSON.stringify(receipt) });
      expect(await reopened.listToolCalls!(first.state.runId)).toEqual([expect.objectContaining({ status: "completed" })]);
      expect((await reopened.load(first.state.runId))?.status).toBe("completed");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
