"use client";

import { useState } from "react";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type ChatStreamEvent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "finish";
      sessionId: string;
      status: string;
    }
  | {
      type: "error";
      error: string;
    };

const appendAssistantText = (messages: ChatMessage[], id: string, text: string): ChatMessage[] =>
  messages.map((message) =>
    message.id === id
      ? {
          ...message,
          text: `${message.text}${text}`
        }
      : message
  );

export default function Page() {
  const [sessionId, setSessionId] = useState<string>();
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string>();

  async function send() {
    const text = message.trim();
    if (!text || isStreaming) {
      return;
    }

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      text
    };
    const assistantMessage: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      text: ""
    };

    setMessage("");
    setError(undefined);
    setIsStreaming(true);
    setMessages((current) => [...current, userMessage, assistantMessage]);

    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, sessionId })
      });

      if (!response.ok || !response.body) {
        throw new Error(await response.text());
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          const event = JSON.parse(line) as ChatStreamEvent;
          if (event.type === "text") {
            setMessages((current) => appendAssistantText(current, assistantMessage.id, event.text));
          } else if (event.type === "finish") {
            setSessionId(event.sessionId);
          } else {
            throw new Error(event.error);
          }
        }
      }

      if (buffer.trim()) {
        const event = JSON.parse(buffer) as ChatStreamEvent;
        if (event.type === "text") {
          setMessages((current) => appendAssistantText(current, assistantMessage.id, event.text));
        } else if (event.type === "finish") {
          setSessionId(event.sessionId);
        } else {
          throw new Error(event.error);
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setMessages((current) =>
        appendAssistantText(
          current,
          assistantMessage.id,
          "The streaming request failed. Check the server logs and provider credentials."
        )
      );
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <main>
      <h1>Zhivex Runner</h1>
      <p>Session: {sessionId ?? "new"}</p>
      <div aria-live="polite">
        {messages.map((item) => (
          <p key={item.id}>
            <strong>{item.role}:</strong> {item.text || (item.role === "assistant" ? "..." : "")}
          </p>
        ))}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={3}
          disabled={isStreaming}
        />
        <button type="submit" disabled={isStreaming || !message.trim()}>
          {isStreaming ? "Streaming" : "Send"}
        </button>
      </form>
    </main>
  );
}
