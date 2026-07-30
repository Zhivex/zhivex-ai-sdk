# Next.js Runner Guide

Use the SDK from server code: route handlers, server actions, API routes, or jobs. A React component should call your backend with `fetch`; it should not hold provider keys or database clients.

## Install

```bash
bun add @zhivex-ai/react @zhivex-ai/sdk @zhivex-ai/openai react react-dom
```

## Route Handler

`app/api/chat/route.ts`:

```ts
import { Agent, createPostgresSessionService, createRunner } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

export const runtime = "nodejs";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const agent = new Agent({
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

Import `@zhivex-ai/react/styles.css` once from `app/layout.tsx`, then use the ready-made chat or compose the lower-level primitives:

```tsx
"use client";

import { ZhivexChat, useZhivexChat } from "@zhivex-ai/react";

export function ChatBox() {
  const chat = useZhivexChat({ endpoint: "/api/chat/stream" });

  return <ZhivexChat controller={chat} />;
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

For streaming UIs, keep the same server boundary and use `toUIRunnerStreamResponse()`. It forwards normalized UI chunks, waits for `Runner.collect()` so persistence finishes, suppresses the internal `AgentRunState`, and emits a final `session-finish` event.

```ts
import {
  fromUIMessage,
  toUIRunnerStreamResponse,
  type AgentApprovalResponse,
  type UIMessage
} from "@zhivex-ai/sdk";

const body = await request.json() as {
  message?: UIMessage;
  sessionId?: string;
  approvals?: AgentApprovalResponse[];
};

if (!body.message && !body.approvals?.length) {
  return Response.json({ error: "Missing message or approval." }, { status: 400 });
}

const stream = runner.stream({
  userId,
  sessionId: body.sessionId,
  messages: body.message ? [fromUIMessage(body.message)] : undefined,
  approvals: body.approvals,
  abortSignal: request.signal
});

return toUIRunnerStreamResponse(stream);
```

The default React transport sends only the latest user message because `Runner + SessionService` owns prior history. Approval resumes omit that message to avoid recording it twice.

The repo example in `examples/next-runner` includes both `/api/chat` for simple JSON responses and `/api/chat/stream` for the React/SSE flow.
