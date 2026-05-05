"use client";

import { useState } from "react";

export default function Page() {
  const [sessionId, setSessionId] = useState<string>();
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);

  async function send() {
    const text = message.trim();
    if (!text) return;

    setMessage("");
    setMessages((current) => [...current, { role: "user", text }]);

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, sessionId })
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = (await response.json()) as {
      sessionId: string;
      text: string;
    };

    setSessionId(data.sessionId);
    setMessages((current) => [...current, { role: "assistant", text: data.text }]);
  }

  return (
    <main>
      <h1>Zhivex Runner</h1>
      {messages.map((item, index) => (
        <p key={index}>
          <strong>{item.role}:</strong> {item.text}
        </p>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input value={message} onChange={(event) => setMessage(event.target.value)} />
        <button type="submit">Send</button>
      </form>
    </main>
  );
}
