import { describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";

import {
  streamLiveAgent,
  tool,
  type RealtimeConnection,
  type RealtimeConnectionFactory,
  type RealtimeModel
} from "../src/index.js";
import { createGemini } from "../../gemini/src/index.js";
import { createOpenAI } from "../../openai/src/index.js";
import { createQwen, type QwenRegion } from "../../qwen/src/index.js";
import { resolveAgentRealtimeCertificationConfig } from "../../../scripts/agent-realtime-certification-config.js";

const certification = resolveAgentRealtimeCertificationConfig();
const describeCertification = certification.enabled
  ? (describe.sequential ?? describe)
  : describe.skip;

type QueuedFrame = string | Error | undefined;

const frameText = (data: RawData) =>
  Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : Buffer.from(data).toString("utf8");

const openNodeRealtimeConnection: RealtimeConnectionFactory = async (
  url,
  headers,
  options
) => {
  const maxIncomingFrameBytes = options?.maxIncomingFrameBytes ?? 16 * 1024 * 1024;
  const socket = options?.subprotocols?.length
    ? new WebSocket(url, options.subprotocols, { headers, maxPayload: maxIncomingFrameBytes })
    : new WebSocket(url, { headers, maxPayload: maxIncomingFrameBytes });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
      socket.off("open", onOpen);
      socket.off("error", onError);
      callback();
    };
    const onOpen = () => finish(resolve);
    const onError = (error: Error) => finish(() => reject(error));
    const onAbort = () => {
      socket.close();
      finish(() => reject(new Error("Realtime certification connection aborted.")));
    };
    const timer = setTimeout(
      () => {
        socket.close();
        finish(() => reject(new Error("Realtime certification connection timed out.")));
      },
      options?.timeoutMs ?? certification.timeoutMs
    );

    socket.once("open", onOpen);
    socket.once("error", onError);
    if (options?.signal?.aborted) {
      onAbort();
    } else {
      options?.signal?.addEventListener("abort", onAbort, { once: true });
    }
  });

  const queue: QueuedFrame[] = [];
  const receivers: Array<(frame: QueuedFrame) => void> = [];
  let closed = false;
  let failure: Error | undefined;
  const push = (frame: QueuedFrame) => {
    const receiver = receivers.shift();
    if (receiver) {
      receiver(frame);
    } else {
      queue.push(frame);
    }
  };

  socket.on("message", (data) => push(frameText(data)));
  socket.on("close", () => {
    closed = true;
    while (receivers.length) receivers.shift()!(undefined);
  });
  socket.on("error", (error) => {
    failure = error;
    while (receivers.length) receivers.shift()!(error);
  });

  return {
    async sendJson(payload) {
      socket.send(JSON.stringify(payload));
    },
    async recvJson() {
      if (failure) throw failure;
      const frame = queue.length
        ? queue.shift()
        : closed
          ? undefined
          : await new Promise<QueuedFrame>((resolve) => receivers.push(resolve));
      if (frame instanceof Error) throw frame;
      return frame === undefined ? undefined : JSON.parse(frame);
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(terminateTimer);
          socket.off("close", finish);
          resolve();
        };
        const terminateTimer = setTimeout(() => {
          socket.terminate();
          finish();
        }, 1_000);
        socket.once("close", finish);
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        } else {
          socket.close();
        }
      });
    }
  } satisfies RealtimeConnection;
};

const createRealtimeModel = (
  provider: (typeof certification.providers)[number]
): RealtimeModel => {
  if (provider.name === "gemini") {
    return createGemini({
      apiKey: provider.apiKey,
      baseURL: process.env.GEMINI_BASE_URL,
      realtimeURL: process.env.GEMINI_REALTIME_URL
    }).realtimeModel!(provider.modelId);
  }
  if (provider.name === "qwen") {
    return createQwen({
      apiKey: provider.apiKey,
      baseURL: process.env.QWEN_BASE_URL,
      taskBaseURL: process.env.QWEN_TASK_BASE_URL,
      realtimeURL: process.env.QWEN_REALTIME_URL,
      workspaceId: process.env.QWEN_WORKSPACE_ID,
      region: process.env.QWEN_REGION as QwenRegion | undefined
    }).realtimeModel!(provider.modelId);
  }
  return createOpenAI({
    apiKey: provider.apiKey,
    baseURL: process.env.OPENAI_BASE_URL,
    realtimeURL: process.env.OPENAI_REALTIME_URL,
    realtimeConnectionFactory: openNodeRealtimeConnection
  }).realtimeModel!(provider.modelId);
};

describeCertification("streamLiveAgent live provider certification", () => {
  for (const provider of certification.providers) {
    it(
      `${provider.name}/${provider.modelId} completes a real live-agent text turn`,
      async () => {
        const token = `agent-${provider.name}-realtime-ok`;
        const abortController = new AbortController();
        let toolExecutions = 0;
        let sessionCloseCalls = 0;
        const providerModel = createRealtimeModel(provider);
        const trackedModel: RealtimeModel = {
          provider: providerModel.provider,
          modelId: providerModel.modelId,
          capabilities: providerModel.capabilities,
          async connect(config, options) {
            const session = await providerModel.connect(config, options);
            const close = session.close.bind(session);
            session.close = async () => {
              sessionCloseCalls += 1;
              await close();
            };
            return session;
          }
        };
        const live = streamLiveAgent(
          {
            id: `certify-${provider.name}-realtime-agent`,
            model: trackedModel,
            instructions:
              "You must call certify_live_once exactly once with value 2 before answering. " +
              "The tool result is the only source of the non-sensitive certification nonce. After it returns, reply with that exact nonce and no other text.",
            tools: {
              certify_live_once: tool({
                name: "certify_live_once",
                description: "Returns a non-sensitive certification nonce required to answer the user. This tool must be called exactly once.",
                schema: z.object({ value: z.number().int() }).strict(),
                execute: ({ value }) => {
                  toolExecutions += 1;
                  return { certified: true, value, token };
                }
              })
            }
          },
          {
            prompt:
              "Obtain the non-sensitive certification nonce by calling certify_live_once exactly once with value 2, then reply with the nonce returned by the tool.",
            ...(provider.name === "gemini"
              ? {
                  realtime: {
                    outputAudioMediaType: "audio/pcm",
                    outputAudioTranscription: true
                  }
                }
              : {}),
            connectOptions: {
              signal: abortController.signal,
              timeoutMs: certification.timeoutMs
            }
          }
        );

        const eventTypes: string[] = [];
        const textChunks: string[] = [];
        const consumeEvents = (async () => {
          for await (const event of live.eventStream) eventTypes.push(event.type);
        })();
        const consumeText = (async () => {
          for await (const chunk of live.textStream) textChunks.push(chunk);
        })();
        let timeout: ReturnType<typeof setTimeout> | undefined;

        try {
          const [, , final] = await Promise.race([
            Promise.all([consumeEvents, consumeText, live.collect()]),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => {
                abortController.abort();
                reject(
                  new Error(
                    `Timed out certifying streamLiveAgent for ${provider.name}/${provider.modelId}. Events: ${eventTypes.join(", ") || "none"}`
                  )
                );
              }, certification.timeoutMs);
            })
          ]);

          expect(final.status, final.error?.message).toBe("completed");
          expect(
            toolExecutions,
            `Expected one tool execution; output=${JSON.stringify(final.outputText)} events=${eventTypes.join(",")}`
          ).toBe(1);
          expect(final.toolResults).toHaveLength(1);
          expect(final.toolResults[0]).toMatchObject({
            toolName: "certify_live_once",
            isError: false,
            output: { certified: true, value: 2 }
          });
          expect(final.outputText.trim()).not.toHaveLength(0);
          expect(final.outputText.toLowerCase()).toContain(token);
          expect((textChunks.join("") || final.outputText).trim()).not.toHaveLength(0);
          expect(eventTypes).toEqual(
            expect.arrayContaining([
              "agent-run-start",
              "realtime-start",
              "realtime-tool-call",
              "tool-call",
              "realtime-response-complete",
              "agent-run-finish"
            ])
          );
          expect(sessionCloseCalls).toBe(1);
          console.log(`streamLiveAgent live certification: ${provider.name}/${provider.modelId} PASS`);
        } finally {
          if (timeout) clearTimeout(timeout);
          abortController.abort();
          if (sessionCloseCalls === 0) {
            await live.session.then((session) => session.close()).catch(() => {});
          }
        }
      },
      certification.timeoutMs + 15_000
    );
  }
});
