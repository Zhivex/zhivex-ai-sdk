"use client";

import { useChat } from "@ai-sdk/react";
import { createAISDKUIChatTransport } from "@zhivex-ai/react/compat";
import { useMemo, useState, type FormEvent } from "react";

export default function AISDKUIPage() {
  const [input, setInput] = useState("");
  const transport = useMemo(
    () => createAISDKUIChatTransport({
      endpoint: "/api/chat/stream",
      requestTimeoutMs: 90_000,
      streamIdleTimeoutMs: 30_000,
      maxEventChars: 256 * 1024,
      maxStreamChars: 4 * 1024 * 1024,
      maxRequestBytes: 64 * 1024
    }),
    []
  );
  const { messages, sendMessage, status, error, stop } = useChat({ transport });
  const busy = status === "submitted" || status === "streaming";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    await sendMessage({ text });
  };

  return (
    <main style={{ margin: "0 auto", maxWidth: "48rem", padding: "2rem 1rem" }}>
      <p><a href="/">Back to the native Zhivex UI</a></p>
      <h1>AI SDK UI compatibility</h1>
      <p>
        This page uses the real <code>@ai-sdk/react</code> <code>useChat</code>
        reducer against the same Zhivex Runner endpoint.
      </p>
      <div aria-live="polite">
        {messages.map((message) => (
          <article key={message.id} style={{ margin: "1rem 0" }}>
            <strong>{message.role}</strong>
            {message.parts.map((part, index) => {
              if (part.type === "text") {
                return <p key={index}>{part.text}</p>;
              }
              if (part.type === "reasoning") {
                return <details key={index}><summary>Reasoning</summary>{part.text}</details>;
              }
              if (part.type === "dynamic-tool") {
                return <pre key={index}>{JSON.stringify(part, null, 2)}</pre>;
              }
              if (part.type === "file") {
                return <p key={index}>File: {part.mediaType}</p>;
              }
              return <p key={index}>Explicitly degraded part: {part.type}</p>;
            })}
          </article>
        ))}
      </div>
      {error ? <p role="alert">The chat request failed.</p> : null}
      <form onSubmit={submit}>
        <label htmlFor="ai-sdk-chat-input">Message</label>
        <input
          id="ai-sdk-chat-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>Send</button>
        {busy ? <button type="button" onClick={stop}>Stop</button> : null}
      </form>
    </main>
  );
}
