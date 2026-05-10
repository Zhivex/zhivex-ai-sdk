# Next.js Runner Guide

Use the SDK from server code: route handlers, server actions, API routes, or jobs. A React component should call your backend with `fetch`; it should not hold provider keys or database clients.

## Install

```bash
bun add @zhivex-ai/sdk @zhivex-ai/openai
```

## Route Handler

`app/api/chat/route.ts`:

```ts
import { createAgent, createPostgresSessionService, createRunner } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

export const runtime = "nodejs";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const agent = createAgent({
  model: openai("gpt-4o-mini"),
  instructions: "You are a concise support assistant."
});

const sessionService = createPostgresSessionService({
  client: postgresClient
});

const runner = createRunner({
  appName: "next-support",
  agent,
  sessionService
});

export async function POST(request: Request) {
  const body = await request.json() as {
    message?: string;
    sessionId?: string;
  };

  if (!body.message) {
    return Response.json({ error: "Missing message." }, { status: 400 });
  }

  const userId = await resolveCurrentUserId(request);

  const result = await runner.run({
    userId,
    sessionId: body.sessionId,
    prompt: body.message
  });

  return Response.json({
    sessionId: result.session.sessionId,
    text: result.output.outputText,
    status: result.output.status
  });
}
```

`postgresClient` and `resolveCurrentUserId()` are app-owned. The SDK does not own auth, tenancy, billing, or database connection management.

The SDK does not import a Postgres driver. Use the driver or managed database client already chosen by your app, and pass a compatible `query(sql, params)` client into `createPostgresSessionService()`.

## Client Component

```tsx
"use client";

import { useState } from "react";

export function ChatBox() {
  const [sessionId, setSessionId] = useState<string>();
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);

  async function send() {
    const userMessage = message.trim();
    if (!userMessage) return;

    setMessage("");
    setMessages((current) => [...current, { role: "user", text: userMessage }]);

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: userMessage })
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = await response.json() as {
      sessionId: string;
      text: string;
    };

    setSessionId(data.sessionId);
    setMessages((current) => [...current, { role: "assistant", text: data.text }]);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div>
        {messages.map((item, index) => (
          <p key={index}>
            <strong>{item.role}:</strong> {item.text}
          </p>
        ))}
      </div>
      <input value={message} onChange={(event) => setMessage(event.target.value)} />
      <button type="submit">Send</button>
    </form>
  );
}
```

## Local Development Store

For a local-only route handler, file-backed sessions are fine:

```ts
import { createFileSessionService } from "@zhivex-ai/sdk";

const sessionService = createFileSessionService({
  directory: ".zhivex/sessions"
});
```

Do not use this as the primary production store on Vercel/serverless deployments. Prefer Postgres for shared, durable state.

## Streaming Shape

For streaming UIs, keep the same server boundary and expose a stream from the route handler. The SDK runtime can stream through `runner.stream()`, while your route decides whether the wire format is SSE, UI chunks, or a custom protocol.

```ts
const stream = runner.stream({
  userId,
  sessionId,
  prompt: body.message
});

const encoder = new TextEncoder();

return new Response(
  new ReadableStream({
    async start(controller) {
      for await (const chunk of stream.textStream) {
        controller.enqueue(encoder.encode(chunk));
      }
      await stream.collect();
      controller.close();
    }
  }),
  {
    headers: {
      "content-type": "text/plain; charset=utf-8"
    }
  }
);
```

Use `stream.collect()` to persist the final session state after the stream completes.
