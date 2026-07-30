"use client";

import { ZhivexChat, useZhivexChat } from "@zhivex-ai/react";

export default function Page() {
  const chat = useZhivexChat({
    endpoint: "/api/chat/stream"
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
        header={
          <div>
            <strong>Zhivex Runner</strong>
            <div style={{ color: "var(--zhivex-color-muted)", fontSize: "0.8rem" }}>
              Session: {chat.sessionId ?? "new"}
            </div>
          </div>
        }
      />
    </main>
  );
}
