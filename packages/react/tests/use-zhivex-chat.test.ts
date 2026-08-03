// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useZhivexChat } from "../src/use-zhivex-chat.js";
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
