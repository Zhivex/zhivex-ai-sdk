"use client";

import { useMemo } from "react";
import {
  ZhivexChat,
  createFetchChatTransport,
  useZhivexChat
} from "@zhivex-ai/react";

export default function Page() {
  const transport = useMemo(
    () => createFetchChatTransport({
      endpoint: "/api/chat/stream",
      requestTimeoutMs: 90_000,
      streamIdleTimeoutMs: 30_000,
      maxEventChars: 256 * 1024,
      maxStreamChars: 4 * 1024 * 1024
    }),
    []
  );
  const chat = useZhivexChat({
    transport
  });

  return (
    <main
      style={{
        margin: "0 auto",
        maxWidth: "64rem",
        minHeight: "100dvh",
        padding: "clamp(1rem, 4vw, 3rem)"
      }}
    >
      <ZhivexChat
        controller={chat}
        composerProps={{ allowAttachments: false }}
        header={
          <div>
            <strong>Zhivex Runner</strong>
            <div style={{ color: "var(--zhivex-color-muted)", fontSize: "0.8rem" }}>
              Session: {chat.sessionId ?? "new"}
            </div>
          </div>
        }
        starterPrompts={[
          "Summarize this session",
          "Help me plan the next task"
        ]}
      />
      <p style={{ marginTop: "1rem", textAlign: "center" }}>
        Already use AI SDK UI? Open the{" "}
        <a href="/ai-sdk-ui">useChat compatibility fixture</a>.
      </p>
    </main>
  );
}
