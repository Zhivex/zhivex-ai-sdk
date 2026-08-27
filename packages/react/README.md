# @zhivex-ai/react

Headless chat state, fetch/SSE transport, and accessible customizable React components for Zhivex AI SDK.

The browser package never runs providers or tools. Keep credentials, durable sessions, authorization, and tool execution in a server route.

## Install

```bash
bun add @zhivex-ai/react @zhivex-ai/sdk @zhivex-ai/openai react react-dom
```

To keep an existing AI SDK UI frontend, install its certified major line and
use the Beta compatibility entrypoint:

```bash
bun add @zhivex-ai/react ai@^7 @ai-sdk/react@^4
```

```tsx
import { useChat } from "@ai-sdk/react";
import { createAISDKUIChatTransport } from "@zhivex-ai/react/compat";

const chat = useChat({
  transport: createAISDKUIChatTransport({ endpoint: "/api/chat/stream" })
});
```

This keeps the AI SDK reducer and components, converts message/tool/reasoning
parts at the transport boundary, rejects redirects, propagates abort, and
applies bounded SSE parsing. The supported versions and complete part matrix
are documented in [AI SDK UI Compatibility](../../docs/AI_SDK_UI_COMPAT.md).

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
      starterPrompts={[
        "Summarize the latest updates",
        "Help me plan a rollout"
      ]}
    />
  );
}
```

`useZhivexChat()` performs a `POST` request and consumes the SDK UI stream over SSE. The default request body contains the latest `UIMessage`, current `sessionId`, and approval decisions. A `Runner` remains the source of truth for durable conversation history.

The ready-made chat uses the controller's richer capabilities when available:

- `activity` becomes an expandable step/run progress indicator.
- `sendMessage()` enables bounded file, image, and audio attachments.
- `canReload` enables the built-in retry action only for transports that explicitly support idempotent regeneration.
- assistant messages include copy, status, and optional retry actions.

Transport and server error details are hidden from users by default. Use
`formatError` to return an application-safe message, or enable
`showErrorDetails` only in a trusted diagnostic surface.

The default fetch transport rejects redirects, limits HTTP diagnostic bodies to 8 KiB, limits each SSE response to 16 MiB and 10,000 events, aborts the whole request after 120 seconds, and aborts a stream after 30 seconds without response bytes. Configure the bounds or explicitly disable only the timeouts for longer agent workloads:

```tsx
import { createFetchChatTransport, useZhivexChat } from "@zhivex-ai/react";

const chat = useZhivexChat({
  transport: createFetchChatTransport({
    endpoint: "/api/chat",
    requestTimeoutMs: 5 * 60_000,
    streamIdleTimeoutMs: 60_000,
    maxErrorBodyBytes: 8 * 1024,
    maxStreamChars: 16 * 1024 * 1024,
    maxStreamEvents: 10_000
  })
});
```

Set either timeout to `false` only when another application-level deadline and cancellation mechanism is present. Following redirects requires an explicit `redirect: "follow"` opt-in because a `307` or `308` can replay the chat POST body to the redirect destination.

HTTP response bodies are retained in bounded `ChatTransportError.responseBody`
for diagnostics, but are not included in the public error message. Use
`formatError` only when the server response is explicitly safe to show users.

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

Force a theme or use the compact density without replacing the stylesheet:

```tsx
<ZhivexChat
  controller={chat}
  density="compact"
  theme="dark"
/>
```

`theme` accepts `"system"` (default), `"light"`, or `"dark"`. Every primitive
also exposes a stable `data-slot` attribute for application-owned styling.

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

`MessageList` follows new content only while the user remains near the bottom.
When the user scrolls upward it preserves their reading position and shows a
localized jump-to-latest control:

```tsx
<ZhivexChat
  controller={chat}
  messageListProps={{
    autoFollow: true,
    autoFollowThreshold: 128
  }}
/>
```

## Multimodal messages and sessions

`send()` remains the text convenience API. Use `sendMessage()` for user image,
audio, or file parts:

```tsx
await chat.sendMessage([
  { type: "image", image: uploadedImageUrl, mediaType: "image/png" },
  { type: "text", text: "Describe this image." }
]);
```

When `ZhivexChat` receives the complete `useZhivexChat()` controller, its
composer automatically exposes file selection, paste, and drag-and-drop. The
defaults allow four attachments of up to 5 MiB each. Keep these limits narrow
or move larger files through an application-owned upload flow:

```tsx
<ZhivexChat
  controller={chat}
  composerProps={{
    accept: "image/*,application/pdf",
    maxAttachments: 3,
    maxAttachmentBytes: 2 * 1024 * 1024,
    onAttachmentError: (error, file) => {
      reportSafeAttachmentError(error, file?.name);
    }
  }}
/>
```

`sendMessage()` rejects with `ChatBusyError` when another request is active;
the legacy text-only `send()` keeps its previous no-op behavior in that case.
The default fetch transport encodes `Uint8Array` and `ArrayBuffer` audio data as
base64 before constructing its JSON request. A custom `buildRequestBody` owns
the serialization and size limits of any binary values it returns.

Prefer bounded application-owned uploads and URLs over placing large base64
payloads in durable session history. `reset()` starts a new local conversation.
For router- or store-owned sessions, pass `sessionId` (`null` explicitly clears
it) and handle `onSessionChange`:

```tsx
const chat = useZhivexChat({
  endpoint: "/api/chat",
  sessionId: selectedSessionId,
  onSessionChange: setSelectedSessionId
});
```

Stream chunks are batched into one React update every 16 ms by default. Set
`streamBatchMs: 0` only when immediate per-chunk rendering is required.
Lifecycle `activity` is reset for each request and bounded to 200 entries by
default; customize it with `activityLimit`. Stopped requests preserve partial
content with message status `stopped`.

Remote image and audio URLs are blocked by default so model or tool content cannot silently create tracking requests from the browser. `data:` and browser `blob:` sources remain supported. Remote HTTP(S) media requires both `allowRemote: true` and an application-owned `allowUrl` allowlist, and is rendered with a `no-referrer` policy. Loopback, private, link-local, embedded private-IP aliases, `.local`, `.internal`, `.lan`, and single-label hosts remain rejected unless separately enabled. Supply a narrow application policy:

```tsx
<ZhivexChat
  controller={chat}
  mediaUrlPolicy={{
    allowRemote: true,
    allowPrivateNetwork: process.env.NODE_ENV === "development",
    allowUrl: (url) => url.hostname.endsWith(".example-cdn.com")
  }}
/>
```

Hostname filtering cannot prevent DNS rebinding by itself. For high-trust applications, combine `allowUrl` with a strict browser CSP and proxy remote media through a server-side fetch policy.

## Headless APIs

- `@zhivex-ai/react/hooks`: `useZhivexChat()` and its client-only types.
- `@zhivex-ai/react/transport`: configurable `fetch`/SSE transport and bounded parsing without a React runtime import.
- `@zhivex-ai/react/compat`: Beta AI SDK UI v7 message, request, response, and `useChat` transport adapters.
- `@zhivex-ai/react/headless`: reducer, state factory, errors, and shared chat types without a React runtime import.
- `@zhivex-ai/react/components`: accessible UI primitives without pulling the hook into the entrypoint.
- `useZhivexChat()`: optimistic messages, multimodal input, abort, approval resume, controlled sessions, and stream reduction.
- `createFetchChatTransport()`: configurable `fetch`/SSE transport.
- `prepareChatRequestBody()`: default latest-message Runner request.
- `parseChatEventStream()`: bounded SSE parser.
- `chatReducer()` and `applyUIMessageChunk()`: deterministic state updates for custom stores or frameworks.

Unknown stream events are ignored so newer servers can interoperate with older clients. Generated image bytes are transported as base64 and converted into renderable data URLs by the reducer.

`reload()` is disabled by default because replaying the last user message can duplicate durable Runner history. Enable `supportsReload` only for an endpoint that implements idempotent regeneration, and pass `onRetry={() => chat.reload()}` to `ZhivexChat` when that guarantee exists.

Approval identity is the pair `provider + approvalRequestId`. The ready-made `ZhivexChat` forwards both values and keeps equal provider-scoped IDs distinct. The legacy three-argument `resolveApproval(id, approved, reason)` form remains available only when the ID has one unambiguous pending match; custom approval UIs should call `resolveApproval(id, approved, reason, provider)`.

The default approval card collects an optional rejection reason and forwards it
to `resolveApproval`. Require it for governed actions through the message-list
configuration:

```tsx
<ZhivexChat
  controller={chat}
  messageListProps={{
    approvalCardProps: {
      reasonRequired: true,
      description: "This action publishes data outside the current workspace."
    }
  }}
/>
```

Completed responses announce a short localized completion message to assistive
technology instead of replaying the entire response. Set
`messageListProps.announceResponseText` only when full-response announcements
are appropriate for the application.
