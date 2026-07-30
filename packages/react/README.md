# @zhivex-ai/react

Headless chat state, fetch/SSE transport, and accessible customizable React components for Zhivex AI SDK.

The browser package never runs providers or tools. Keep credentials, durable sessions, authorization, and tool execution in a server route.

## Install

```bash
bun add @zhivex-ai/react @zhivex-ai/sdk @zhivex-ai/openai react react-dom
```

## Client

Import the default stylesheet once from the root layout or application entrypoint:

```tsx
import "@zhivex-ai/react/styles.css";
```

Create a controller and pass it to the ready-made chat:

```tsx
"use client";

import { ZhivexChat, useZhivexChat } from "@zhivex-ai/react";

export function SupportChat() {
  const chat = useZhivexChat({
    endpoint: "/api/chat"
  });

  return (
    <ZhivexChat
      controller={chat}
      header={<strong>Support assistant</strong>}
    />
  );
}
```

`useZhivexChat()` performs a `POST` request and consumes the SDK UI stream over SSE. The default request body contains the latest `UIMessage`, current `sessionId`, and approval decisions. A `Runner` remains the source of truth for durable conversation history.

## Server Route

This Next.js App Router route keeps identity and provider configuration on the server and finalizes Runner persistence before the terminal `session-finish` event:

```ts
import {
  Agent,
  createPostgresSessionService,
  createRunner,
  fromUIMessage,
  toUIRunnerStreamResponse,
  type AgentApprovalResponse,
  type UIMessage
} from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

export const runtime = "nodejs";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const runner = createRunner({
  appName: "support-chat",
  agent: new Agent({
    model: openai("gpt-4o-mini"),
    instructions: "Answer clearly and briefly."
  }),
  sessionService: createPostgresSessionService({
    client: postgresClient
  })
});

export async function POST(request: Request) {
  const body = await request.json() as {
    message?: UIMessage;
    sessionId?: string;
    approvals?: AgentApprovalResponse[];
  };
  const userId = await resolveCurrentUserId(request);

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
}
```

`postgresClient`, authentication, tenant isolation, request limits, and rate limiting are application-owned.

## Customize

Use CSS variables for visual changes:

```css
.brand-chat {
  --zhivex-color-accent: #7c3aed;
  --zhivex-content-width: 60rem;
  --zhivex-radius: 1.25rem;
}
```

```tsx
<ZhivexChat className="brand-chat" controller={chat} />
```

For structural changes, compose `ChatRoot`, `MessageList`, `Composer`, `Message`, and `MessagePart`, or provide a renderer for individual content parts:

```tsx
<ZhivexChat
  controller={chat}
  renderers={{
    text: ({ part }) => <div className="my-markdown">{part.text}</div>
  }}
/>
```

The default renderer intentionally treats text as plaintext. Applications can plug in their preferred Markdown renderer and sanitization policy.

## Headless APIs

- `useZhivexChat()`: optimistic messages, abort, approval resume, session state, and stream reduction.
- `createFetchChatTransport()`: configurable `fetch`/SSE transport.
- `prepareChatRequestBody()`: default latest-message Runner request.
- `parseChatEventStream()`: bounded SSE parser.
- `chatReducer()` and `applyUIMessageChunk()`: deterministic state updates for custom stores or frameworks.

Unknown stream events are ignored so newer servers can interoperate with older clients. Generated image bytes are transported as base64 and converted into renderable data URLs by the reducer.

`reload()` is disabled by default because replaying the last user message can duplicate durable Runner history. Enable `supportsReload` only for an endpoint that implements idempotent regeneration, and pass `onRetry={() => chat.reload()}` to `ZhivexChat` when that guarantee exists.
