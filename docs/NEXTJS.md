# Next.js Runner Guide

This guide is the React stage of the canonical [Quickstart](./QUICKSTART.md). The source of truth is the executable [`examples/next-runner`](../examples/next-runner/README.md) starter.

## Install

```bash
bun add @zhivex-ai/react @zhivex-ai/sdk @zhivex-ai/openai react react-dom
```

Keep `OPENAI_API_KEY` in `.env` or the deployment's server-side secret store. Do not prefix it with `NEXT_PUBLIC_`.

## Server Runner

Create the provider and runner lazily in a server-only module so builds do not require credentials and browser bundles cannot import them. The starter uses the same `gpt-4o-mini`, `Agent`, `createRunner()`, and `createFileSessionService()` path as the quickstart, with bounded steps, tokens, total time, and durable local sessions.

The essential route shape is:

```ts
import {
  fromUIMessage,
  toUIRunnerStreamResponse,
  type AgentApprovalResponse
} from "@zhivex-ai/sdk";
import {
  ChatRequestError,
  MAX_APPROVALS,
  MAX_SESSION_ID_CHARS,
  noStoreHeaders,
  optionalBoundedString,
  optionalUserMessage,
  readChatJson,
  safeChatErrorResponse
} from "../../../../lib/http";
import { getRunner, resolveCurrentUserId } from "../../../../lib/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readChatJson(request);
    const message = optionalUserMessage(body.message);
    const approvals = body.approvals as AgentApprovalResponse[] | undefined;
    if (approvals !== undefined && (!Array.isArray(approvals) || approvals.length > MAX_APPROVALS)) {
      throw new ChatRequestError(`approvals must contain at most ${MAX_APPROVALS} items.`);
    }
    if (!message && !approvals?.length) {
      return Response.json(
        { error: "Missing message or approval." },
        { status: 400, headers: noStoreHeaders }
      );
    }

    const stream = getRunner().stream({
      userId: await resolveCurrentUserId(request),
      sessionId: optionalBoundedString(body.sessionId, "sessionId", MAX_SESSION_ID_CHARS),
      messages: message ? [fromUIMessage(message)] : undefined,
      approvals,
      abortSignal: request.signal
    });

    return toUIRunnerStreamResponse(stream, { headers: noStoreHeaders });
  } catch (error) {
    return safeChatErrorResponse(error, request);
  }
}
```

The starter's [`lib/http.ts`](../examples/next-runner/lib/http.ts), [`lib/server.ts`](../examples/next-runner/lib/server.ts), and [streaming route](../examples/next-runner/app/api/chat/stream/route.ts) contain this exact flow. They include bounded streaming body reads, runtime validation, safe public errors, local-only identity, timeouts, budget limits, and abort propagation.

`resolveCurrentUserId()` intentionally fails closed in production until the application replaces the local demo identity with authenticated, tenant-scoped identity. Auth, tenancy, rate limits, retention, and database client lifecycle remain application-owned.

## React Client

Import the stylesheet once from `app/layout.tsx`. Configure the browser transport explicitly so request lifetime, idle time, event size, and total stream size remain bounded:

```tsx
"use client";

import { useMemo } from "react";
import {
  ZhivexChat,
  createFetchChatTransport,
  useZhivexChat
} from "@zhivex-ai/react";

export function ChatBox() {
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
  const chat = useZhivexChat({ transport });

  return <ZhivexChat controller={chat} />;
}
```

The transport sends only the latest user message because `Runner + SessionService` owns prior history. Calling `chat.stop()` aborts the request, and the route forwards the signal into the runner.

## Persistence

The starter uses `createFileSessionService({ directory: ".zhivex/sessions" })` only for local development. For serverless or multi-instance production deployments, replace it with `createPostgresSessionService()` and an app-owned compatible database client.

## Run And Verify

From `examples/next-runner`:

```bash
cp .env.example .env
bun install
bun run first-response
bun run typecheck
bun run dev
```

The first script verifies the provider before the UI adds more moving parts. The repository's `bun run smoke:packages` gate separately proves that the same public entrypoints work from candidate tarballs installed in an isolated consumer.
