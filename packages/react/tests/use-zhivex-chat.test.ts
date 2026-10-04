// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useZhivexChat } from "../src/use-zhivex-chat.js";
import { ChatTransportError } from "../src/transport.js";
import { ChatBusyError } from "../src/types.js";
import type {
  ChatStreamChunk,
  ChatTransport,
  ChatTransportRequest,
  UseZhivexChatOptions,
  UseZhivexChatResult
} from "../src/types.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type StreamFactory = (
  request: ChatTransportRequest
) => AsyncIterable<ChatStreamChunk>;

const createTransport = (factory: StreamFactory): ChatTransport => ({
  send: factory
});

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const createDeferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for hook state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const textFrom = (result: UseZhivexChatResult, role: "user" | "assistant") =>
  result.messages
    .filter((message) => message.role === role)
    .flatMap((message) =>
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
    )
    .join("");

interface HookHarnessProps {
  options: UseZhivexChatOptions;
  onRender: (result: UseZhivexChatResult) => void;
}

const HookHarness = ({ options, onRender }: HookHarnessProps) => {
  const result = useZhivexChat(options);
  onRender(result);
  return null;
};

const roots: Root[] = [];

const mountChat = async (options: UseZhivexChatOptions) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  let current: UseZhivexChatResult | undefined;
  const renders: UseZhivexChatResult[] = [];
  const render = async (nextOptions: UseZhivexChatOptions) => {
    await act(async () => {
      root.render(
        createElement(HookHarness, {
          options: nextOptions,
          onRender: (result) => {
            current = result;
            renders.push(result);
          }
        })
      );
    });
  };
  await render(options);

  return {
    get current(): UseZhivexChatResult {
      if (!current) {
        throw new Error("Hook did not render.");
      }
      return current;
    },
    renders,
    rerender: render,
    async unmount() {
      const index = roots.indexOf(root);
      if (index >= 0) {
        roots.splice(index, 1);
      }
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  };
};

afterEach(async () => {
  const mounted = roots.splice(0);
  await act(async () => {
    for (const root of mounted) {
      root.unmount();
    }
  });
  document.body.replaceChildren();
});

describe("useZhivexChat", () => {
  it("recovers automatically without a second send or duplicated replay events", async () => {
    let sends = 0;
    let reconnects = 0;
    const onError = vi.fn();
    const onFinish = vi.fn();
    const chat = await mountChat({ maxReconnectAttempts: 2, onError, onFinish, transport: {
      supportsReconnect: true,
      async *send() {
        sends++;
        yield { type: "text-delta", messageId: "a", role: "assistant", textDelta: "one", replay: { streamId: "r", sequence: 1 } };
        throw new ChatTransportError("offline", { code: "network_error" });
      },
      async *reconnect(request) {
        reconnects++;
        expect(request.checkpoint).toEqual({ streamId: "r", sequence: 1 });
        yield { type: "text-delta", messageId: "a", role: "assistant", textDelta: "one", replay: { streamId: "r", sequence: 1 } };
        yield { type: "text-delta", messageId: "a", role: "assistant", textDelta: "two", replay: { streamId: "r", sequence: 2 } };
        yield { type: "stream-end", replay: { streamId: "r", sequence: 3 } };
      }
    } });
    await act(async () => {
      await expect(chat.current.sendMessageWithResult("hello")).resolves.toEqual({ status: "completed" });
    });
    expect(textFrom(chat.current, "assistant")).toBe("onetwo");
    expect(sends).toBe(1);
    expect(reconnects).toBe(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(chat.current.canReconnect).toBe(false);
  });

  it("reports invalid replay from a timed batch without an unhandled timer exception", async () => {
    const onError = vi.fn();
    const chat = await mountChat({ streamBatchMs: 1, onError, transport: createTransport(async function* () {
      yield { type: "text-delta", messageId: "a", role: "assistant", textDelta: "bad", replay: { streamId: "r", sequence: 3 } };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }) });
    await act(async () => {
      expect((await chat.current.sendMessageWithResult("hello")).status).toBe("error");
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it.each(["transport", "stream"] as const)("returns %s failures and restores the draft", async (failure) => {
    const onError = vi.fn();
    const chat = await mountChat({
      onError,
      transport: createTransport(async function* () {
        yield { type: "text-delta", messageId: "partial", role: "assistant", textDelta: "partial" };
        if (failure === "transport") throw new Error("offline");
        yield { type: "error", error: "server failed" };
      })
    });
    await act(async () => chat.current.setInput("Keep this draft"));
    await act(async () => {
      const result = await chat.current.sendMessageWithResult(chat.current.input);
      expect(result.status).toBe("error");
    });
    expect(chat.current.input).toBe("Keep this draft");
    expect(chat.current.status).toBe("error");
    expect(textFrom(chat.current, "assistant")).toBe("partial");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "edit", "reset", "session", "stop-session"] as const)("preserves draft ownership after %s", async (action) => {
    const release = createDeferred();
    const transport = createTransport(async function* () {
      await release.promise;
      throw new Error("offline");
    });
    const chat = await mountChat({ transport, sessionId: "first" });
    await act(async () => chat.current.setInput("original"));
    let pending!: ReturnType<UseZhivexChatResult["sendMessageWithResult"]>;
    await act(async () => { pending = chat.current.sendMessageWithResult("original"); });
    expect(chat.current.input).toBe("");
    if (action === "session" || action === "stop-session") {
      if (action === "stop-session") await act(async () => chat.current.stop());
      await chat.rerender({ transport, sessionId: "second" });
    } else {
      await act(async () => {
        if (action === "stop") chat.current.stop();
        if (action === "edit") chat.current.setInput("new draft");
        if (action === "reset") chat.current.reset();
      });
    }
    await act(async () => {
      release.resolve();
      expect((await pending).status).toBe(action === "edit" ? "error" : "stopped");
    });
    expect(chat.current.input).toBe(action === "stop" ? "original" : action === "edit" ? "new draft" : "");
  });

  it("reports completion and empty input without changing legacy return values", async () => {
    const chat = await mountChat({ transport: createTransport(async function* () {}) });
    await act(async () => {
      await expect(chat.current.sendMessageWithResult("  ")).resolves.toEqual({ status: "skipped", reason: "empty" });
      chat.current.setInput("draft");
      await expect(chat.current.sendMessageWithResult("draft")).resolves.toEqual({ status: "completed" });
    });
    expect(chat.current.input).toBe("");
    await act(async () => {
      await expect(chat.current.sendMessage("legacy")).resolves.toBeUndefined();
    });
  });

  it("optimistically sends multimodal input and folds a batched stream into final state", async () => {
    const releaseStream = createDeferred();
    let request: ChatTransportRequest | undefined;
    const onFinish = vi.fn();
    const transport = createTransport(async function* (nextRequest) {
      request = nextRequest;
      await releaseStream.promise;
      yield {
        type: "text-delta",
        messageId: "assistant-1",
        role: "assistant",
        textDelta: "Respuesta "
      };
      yield {
        type: "text-delta",
        messageId: "assistant-1",
        role: "assistant",
        textDelta: "final"
      };
      yield {
        type: "finish",
        messageId: "assistant-1",
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      };
    });
    const chat = await mountChat({ transport, streamBatchMs: 25, onFinish });

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = chat.current.sendMessage({
        id: "user-multimodal",
        createdAt: 123,
        metadata: { source: "test" },
        parts: [
          { type: "text", text: "Analizá esto" },
          {
            type: "image",
            image: "https://example.com/chart.png",
            mediaType: "image/png"
          },
          {
            type: "file",
            data: "ZGF0YQ==",
            mediaType: "text/plain",
            filename: "datos.txt"
          }
        ]
      });
      await waitFor(() => request !== undefined);
    });

    expect(chat.current.status).toBe("submitting");
    expect(chat.current.messages).toEqual([
      expect.objectContaining({
        id: "user-multimodal",
        role: "user",
        status: "pending",
        createdAt: 123,
        metadata: { source: "test" },
        parts: [
          { type: "text", text: "Analizá esto" },
          {
            type: "image",
            image: "https://example.com/chart.png",
            mediaType: "image/png"
          },
          {
            type: "file",
            data: "ZGF0YQ==",
            mediaType: "text/plain",
            filename: "datos.txt"
          }
        ]
      })
    ]);
    expect(request?.message).toEqual(chat.current.messages[0]);
    expect(request?.messages).toEqual(chat.current.messages);
    await expect(chat.current.sendMessage("otro envío")).rejects.toMatchObject({
      name: "ChatBusyError",
      code: "chat_busy",
      operation: "send"
    } satisfies Partial<ChatBusyError>);
    await expect(chat.current.send("compatibilidad legacy")).resolves.toBeUndefined();

    await act(async () => {
      releaseStream.resolve();
      await sendPromise;
    });

    expect(chat.current.status).toBe("ready");
    expect(textFrom(chat.current, "assistant")).toBe("Respuesta final");
    expect(chat.current.messages.map((message) => message.status)).toEqual([
      "complete",
      "complete"
    ]);
    expect(chat.current.usage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5
    });
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0]?.[0]).toMatchObject({
      status: "ready",
      usage: { totalTokens: 5 }
    });

    const assistantSnapshots = chat.renders
      .map((result) => textFrom(result, "assistant"))
      .filter(Boolean);
    expect(assistantSnapshots).not.toContain("Respuesta ");
  });

  it("marks partial messages as stopped and calls onFinish once", async () => {
    let request: ChatTransportRequest | undefined;
    const onFinish = vi.fn();
    const transport = createTransport(async function* (nextRequest) {
      request = nextRequest;
      yield {
        type: "text-delta",
        messageId: "assistant-stop",
        role: "assistant",
        textDelta: "Parcial"
      };
      await new Promise<void>((_resolve, reject) => {
        nextRequest.signal.addEventListener(
          "abort",
          () => reject(nextRequest.signal.reason),
          { once: true }
        );
      });
    });
    const chat = await mountChat({ transport, streamBatchMs: 0, onFinish });

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = chat.current.send("detener");
    });
    await waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      return textFrom(chat.current, "assistant") === "Parcial";
    });

    await act(async () => {
      chat.current.stop();
      await sendPromise;
    });

    expect(request?.signal.aborted).toBe(true);
    expect(chat.current.status).toBe("ready");
    expect(chat.current.messages.map((message) => message.status)).toEqual([
      "stopped",
      "stopped"
    ]);
    expect(textFrom(chat.current, "assistant")).toBe("Parcial");
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0]?.[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "assistant-stop", status: "stopped" })
      ])
    );
  });

  it("flushes already received batched content before stopping", async () => {
    const chunkWasQueued = createDeferred();
    const transport = createTransport(async function* (request) {
      yield {
        type: "text-delta",
        messageId: "assistant-batched-stop",
        role: "assistant",
        textDelta: "No perder"
      };
      chunkWasQueued.resolve();
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true }
        );
      });
    });
    const chat = await mountChat({ transport, streamBatchMs: 10_000 });

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = chat.current.send("detener con batch");
      await chunkWasQueued.promise;
    });

    expect(textFrom(chat.current, "assistant")).toBe("");

    await act(async () => {
      chat.current.stop();
      await sendPromise;
    });

    expect(textFrom(chat.current, "assistant")).toBe("No perder");
    expect(chat.current.messages.at(-1)?.status).toBe("stopped");
  });

  it("restores a stopped user message before reloading it", async () => {
    let request: ChatTransportRequest | undefined;
    const transport: ChatTransport = {
      supportsReload: true,
      async *send(nextRequest) {
        request = nextRequest;
        yield {
          type: "finish",
          messageId: "assistant-reload",
          finishReason: "stop"
        };
      }
    };
    const chat = await mountChat({
      transport,
      initialMessages: [
        {
          id: "user-stopped",
          role: "user",
          parts: [{ type: "text", text: "Intentar otra vez" }],
          createdAt: 1,
          status: "stopped"
        },
        {
          id: "assistant-stopped",
          role: "assistant",
          parts: [{ type: "text", text: "Respuesta parcial" }],
          createdAt: 2,
          status: "stopped"
        }
      ]
    });

    await act(async () => {
      await chat.current.reload();
    });

    expect(request?.message).toMatchObject({
      id: "user-stopped",
      status: "pending"
    });
    expect(request?.messages).toHaveLength(1);
    expect(chat.current.messages).toEqual([
      expect.objectContaining({ id: "user-stopped", status: "complete" })
    ]);
  });

  it("aborts and ignores an old request when the controlled session changes", async () => {
    const releaseOldStream = createDeferred();
    let oldRequest: ChatTransportRequest | undefined;
    const onFinish = vi.fn();
    const transport = createTransport(async function* (request) {
      oldRequest = request;
      await releaseOldStream.promise;
      yield {
        type: "text-delta",
        messageId: "assistant-session-a",
        role: "assistant",
        textDelta: "respuesta obsoleta"
      };
    });
    const firstOptions: UseZhivexChatOptions = {
      transport,
      sessionId: "session-a",
      streamBatchMs: 0,
      onFinish
    };
    const chat = await mountChat(firstOptions);

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = chat.current.send("pregunta de A");
      await waitFor(() => oldRequest !== undefined);
    });

    await chat.rerender({
      ...firstOptions,
      sessionId: "session-b"
    });

    expect(oldRequest?.signal.aborted).toBe(true);
    expect(chat.current.sessionId).toBe("session-b");
    expect(chat.current.messages.at(-1)?.status).toBe("stopped");
    expect(onFinish).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseOldStream.resolve();
      await sendPromise;
    });

    expect(textFrom(chat.current, "assistant")).toBe("");
    expect(chat.current.sessionId).toBe("session-b");
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("resumes a pending approval without replaying the user message", async () => {
    const requests: ChatTransportRequest[] = [];
    const approval = {
      provider: "test",
      id: "approval-1",
      name: "delete-record",
      arguments: '{"id":"42"}',
      rawData: { kind: "approval" }
    };
    const transport = createTransport(async function* (request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: "agent-approval-request", approval };
        yield {
          type: "session-finish",
          sessionId: "session-approval",
          status: "waiting_approval"
        };
        return;
      }

      yield {
        type: "agent-approval-resolved",
        approval: request.approvals![0]!
      };
      yield {
        type: "text-delta",
        messageId: "assistant-approved",
        role: "assistant",
        textDelta: "Aprobado"
      };
      yield {
        type: "session-finish",
        sessionId: "session-approval",
        status: "completed"
      };
    });
    const chat = await mountChat({ transport, streamBatchMs: 0 });

    await act(async () => {
      await chat.current.send("continuar");
    });

    expect(chat.current.pendingApprovals).toEqual([approval]);
    expect(chat.current.sessionId).toBe("session-approval");

    await act(async () => {
      await chat.current.resolveApproval("approval-1", true, "Autorizado");
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.message).toBeUndefined();
    expect(requests[1]?.approvals).toEqual([
      {
        provider: "test",
        approvalRequestId: "approval-1",
        approve: true,
        reason: "Autorizado"
      }
    ]);
    expect(requests[1]?.sessionId).toBe("session-approval");
    expect(chat.current.pendingApprovals).toEqual([]);
    expect(textFrom(chat.current, "assistant")).toBe("Aprobado");
  });

  it("reports server session changes and resets local conversation state", async () => {
    const onSessionChange = vi.fn();
    const transport = createTransport(async function* () {
      yield {
        type: "session-finish",
        sessionId: "session-server",
        status: "completed"
      };
    });
    const chat = await mountChat({
      transport,
      initialSessionId: "session-initial",
      onSessionChange
    });

    await act(async () => {
      await chat.current.send("hola");
    });
    expect(chat.current.sessionId).toBe("session-server");
    expect(onSessionChange).toHaveBeenLastCalledWith("session-server");

    await act(async () => {
      chat.current.reset({ sessionId: "session-reset" });
    });

    expect(chat.current).toMatchObject({
      status: "ready",
      sessionId: "session-reset",
      messages: [],
      pendingApprovals: [],
      activity: []
    });
    expect(onSessionChange).toHaveBeenLastCalledWith("session-reset");

    await act(async () => {
      chat.current.reset();
    });
    expect(chat.current.sessionId).toBeUndefined();
    expect(onSessionChange).toHaveBeenLastCalledWith(undefined);
  });

  it("aborts an active request when its component unmounts", async () => {
    let request: ChatTransportRequest | undefined;
    const transport = createTransport(async function* (nextRequest) {
      request = nextRequest;
      await new Promise<void>((_resolve, reject) => {
        nextRequest.signal.addEventListener(
          "abort",
          () => reject(nextRequest.signal.reason),
          { once: true }
        );
      });
    });
    const chat = await mountChat({ transport });

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = chat.current.send("queda pendiente");
      await waitFor(() => request !== undefined);
    });

    await chat.unmount();
    await sendPromise;

    expect(request?.signal.aborted).toBe(true);
  });
});


describe("remote cancellation", () => {
  const checkpoint = { streamId: "execution-a", sequence: 1 };

  it("awaits acknowledgement after connection loss and coalesces concurrent requests", async () => {
    const acknowledgement = createDeferred();
    const cancel = vi.fn(async () => { await acknowledgement.promise; return { status: "confirmed" as const }; });
    const transport: ChatTransport = {
      async *send() {
        yield { type: "text-delta", id: "answer", textDelta: "partial", replay: checkpoint };
        throw new ChatTransportError("Disconnected", { code: "network_error" });
      }, requestCancellation: cancel
    };
    const chat = await mountChat({ transport, initialSessionId: "session-a", streamBatchMs: 0 });
    await act(async () => { await chat.current.send("hello"); });
    let first!: ReturnType<UseZhivexChatResult["cancel"]>;
    let second!: typeof first;
    await act(async () => {
      first = chat.current.cancel();
      second = chat.current.cancel();
    });
    expect(first).toBe(second);
    expect(chat.current.cancellation?.status).toBe("pending");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transport.requestCancellation!).mock.calls[0]?.[0]).toMatchObject({ checkpoint, sessionId: "session-a" });
    await act(async () => { acknowledgement.resolve(); await first; });
    expect(await first).toMatchObject({ status: "confirmed", checkpoint });
    expect(chat.current.cancellation?.status).toBe("confirmed");
  });

  it.each([
    [undefined, "uncertain"],
    [new Error("Connection lost"), "uncertain"],
    [new ChatTransportError("Denied", { code: "http_error", status: 403 }), "failed"],
    [new ChatTransportError("Server failed", { code: "http_error", status: 503 }), "uncertain"]
  ] as const)("distinguishes ambiguous delivery from rejection: %s", async (error, status) => {
    const chat = await mountChat({ initialCheckpoint: checkpoint, transport: {
      async *send() {},
      async cancel() { if (error) throw error; }
    } });
    await act(async () => { expect(await chat.current.cancel()).toMatchObject({ status }); });
    expect(chat.current.cancellation?.status).toBe(status);
  });

  it("does not let an old cancellation update a new session", async () => {
    const acknowledgement = createDeferred();
    const transport: ChatTransport = { async *send() {}, async requestCancellation() {
      await acknowledgement.promise;
      return { status: "confirmed" };
    } };
    const chat = await mountChat({ transport, sessionId: "a", initialCheckpoint: checkpoint });
    let pending!: ReturnType<UseZhivexChatResult["cancel"]>;
    await act(async () => { pending = chat.current.cancel(); });
    await chat.rerender({ transport, sessionId: "b" });
    await act(async () => { acknowledgement.resolve(); await pending; });
    expect(await pending).toMatchObject({ status: "confirmed", checkpoint });
    expect(chat.current.sessionId).toBe("b");
    expect(chat.current.cancellation).toBeUndefined();
  });

  it("detaches without remote cancellation and preserves identity for a later cancel", async () => {
    const finished = createDeferred();
    const cancel = vi.fn(async () => ({ status: "confirmed" as const }));
    const transport: ChatTransport = { requestCancellation: cancel, async *send(request) {
      yield { type: "text-delta", id: "answer", textDelta: "partial", replay: checkpoint };
      request.signal.addEventListener("abort", finished.resolve, { once: true });
      await finished.promise;
    } };
    const chat = await mountChat({ transport, streamBatchMs: 0 });
    let sending!: Promise<void>;
    await act(async () => { sending = chat.current.send("hello"); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { chat.current.detach(); await sending; });
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => { await chat.current.cancel(); });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(chat.current.cancellation?.status).toBe("confirmed");
  });
});

it.each(["reset", "replace", "send"] as const)("ignores cancellation completion after %s", async (operation) => {
  const acknowledgement = createDeferred();
  const onError = vi.fn();
  const chat = await mountChat({ onError, initialCheckpoint: { streamId: "old", sequence: 1 }, transport: {
    async *send() {},
    async requestCancellation() { await acknowledgement.promise; throw new Error("Old execution failed"); }
  } });
  let pending!: ReturnType<UseZhivexChatResult["cancel"]>;
  await act(async () => { pending = chat.current.cancel(); });
  await act(async () => {
    if (operation === "reset") chat.current.reset();
    else if (operation === "replace") chat.current.setMessages([]);
    else await chat.current.send("New work");
    acknowledgement.resolve();
    await pending;
  });
  expect((await pending).status).toBe("uncertain");
  expect(chat.current.cancellation).toBeUndefined();
  expect(onError).not.toHaveBeenCalled();
});

it("cancels through the original transport after a disconnected stream", async () => {
  const original = vi.fn(async () => ({ status: "confirmed" as const }));
  const replacement = vi.fn(async () => ({ status: "failed" as const }));
  const chat = await mountChat({ streamBatchMs: 0, transport: {
    requestCancellation: original,
    async *send() {
      yield { type: "stream-start", replay: { streamId: "original", sequence: 1 } };
      throw new Error("Disconnected");
    }
  } });
  await act(async () => { await chat.current.send("Work"); });
  await chat.rerender({ transport: { async *send() {}, requestCancellation: replacement } });
  await act(async () => { await chat.current.cancel(); });
  expect(original).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
});

it("keeps idle stop a synchronous no-op and reports missing cancellation identity as uncertain", async () => {
  const cancel = vi.fn(async () => {});
  const chat = await mountChat({ transport: { async *send() {}, cancel } });
  await act(async () => { expect(chat.current.stop()).toBeUndefined(); });
  expect(chat.current.cancellation).toBeUndefined();
  await act(async () => { await chat.current.cancel(); });
  expect(chat.current.cancellation?.status).toBe("uncertain");
  expect(cancel).not.toHaveBeenCalled();
});
