# AI SDK UI Compatibility

`@zhivex-ai/react/compat` is the Beta transport boundary for applications that
already use AI SDK UI. It lets the real `@ai-sdk/react` `useChat` reducer consume
a Zhivex `streamText`, `Agent`, or `Runner` stream without moving providers,
tools, credentials, or durable state into the browser.

The certified line is deliberately explicit:

| Package | Fixture version | Supported range |
| --- | --- | --- |
| `ai` | `7.0.79` | `>=7.0.0 <8` |
| `@ai-sdk/react` | `4.0.82` | `>=4.0.0 <5` |

The fixture versions are exact development dependencies and are exercised in
CI. A new major line requires new fixtures, matrix review, browser tests, and a
release note; compatibility with private AI SDK internals is not promised.

## Install

```bash
bun add @zhivex-ai/react ai@^7 @ai-sdk/react@^4
```

## Recommended migration: keep the existing Zhivex route

Pass the compatibility transport to the existing `useChat` hook. The AI SDK
reducer and application-owned message components stay in place.

```tsx
"use client";

import { useChat } from "@ai-sdk/react";
import { createAISDKUIChatTransport } from "@zhivex-ai/react/compat";
import { useMemo } from "react";

export function Chat() {
  const transport = useMemo(
    () => createAISDKUIChatTransport({
      endpoint: "/api/chat/stream",
      requestTimeoutMs: 90_000,
      streamIdleTimeoutMs: 30_000,
      maxRequestBytes: 64 * 1024,
      maxEventChars: 256 * 1024,
      maxStreamChars: 4 * 1024 * 1024,
      maxStreamEvents: 10_000
    }),
    []
  );

  const chat = useChat({ transport });
  // Keep the existing AI SDK UI renderer and reducer.
}
```

The default body is the durable Runner contract:

```json
{
  "message": { "id": "...", "role": "user", "parts": [] },
  "sessionId": "useChat-id"
}
```

Only the latest user message is sent. Runner remains the source of truth for
history. Approval resumes omit `message` and send the decoded Zhivex approval
identity. Use `buildRequestBody` only when the application route has a different
bounded schema.

Regeneration is disabled by default because replaying the last user turn can
duplicate durable Runner history. Set `supportsRegenerate: true` only together
with a `buildRequestBody` target that implements idempotent regeneration.

## Alternative migration: emit the AI SDK UI stream protocol on the server

For a frontend that must keep `DefaultChatTransport`, parse its request and
return the AI SDK UI v1 SSE protocol directly:

```ts
import {
  parseAISDKUIMessageRequest,
  toAISDKUIRunnerStreamResponse
} from "@zhivex-ai/react/compat";

export async function POST(request: Request) {
  const body = await parseAISDKUIMessageRequest(request, {
    maxBytes: 64 * 1024,
    maxMessages: 50,
    maxParts: 200
  });
  const latest = body.modelMessages.at(-1);

  if (!latest || latest.role !== "user") {
    return Response.json({ error: "Missing user message." }, { status: 400 });
  }

  const stream = runner.stream({
    userId: await resolveCurrentUserId(request),
    sessionId: body.chatId,
    messages: [latest],
    abortSignal: request.signal
  });

  return toAISDKUIRunnerStreamResponse(stream);
}
```

`toAISDKUIRunnerStreamResponse()` waits for Runner collection before the
terminal event, preserving durable session writes. The response includes
`x-vercel-ai-ui-message-stream: v1` and a `[DONE]` sentinel.

## Message part compatibility

Every public AI SDK UI v7 message-part family has an explicit treatment:

| AI SDK UI part | Status | Zhivex treatment |
| --- | --- | --- |
| `text` | Supported | Maps bidirectionally to Zhivex `text`. |
| `reasoning` | Supported with provider boundary | Maps to tagged `reasoning_content` provider data and back. Providers that do not expose reasoning cannot synthesize it. |
| `file` | Supported with limits | Image, audio, and generic file URLs/data URLs map to the corresponding Zhivex input part. `providerReference` and AI-only provider metadata are not forwarded. |
| `tool-{name}` | Supported for settled states | Static tool parts map to Zhivex tool calls/results. `input-streaming` is explicitly preserved or rejected because Zhivex emits completed tool calls. |
| `dynamic-tool` | Supported for settled states | Input, output, error, denial, and approval state map without requiring a compile-time tool registry. |
| `data-*` | Explicit degradation | Preserved as tagged `ai-sdk` provider data; it is not interpreted by the model runtime. |
| `source-url` | Explicit degradation | Preserved as tagged provider data; Zhivex does not claim a shared source-part contract yet. |
| `source-document` | Explicit degradation | Preserved as tagged provider data. |
| `reasoning-file` | Explicit degradation | Preserved as tagged provider data. |
| `custom` | Explicit degradation | Preserved as tagged provider data. |
| `step-start` | Explicit degradation | Preserved as tagged provider data on request; native agent steps are emitted as stream boundaries on response. |
| Unknown future part | Preserve or safe error | Default is lossless tagged provider data. Set `unsupportedParts: "error"` to fail closed. |

Arbitrary Zhivex provider data is reduced to `{ provider, kind, degraded: true }`
when converted to an AI SDK UI message. Set `providerData: "preserve"` only for a
trusted surface that has its own DLP and rendering policy.

## Stream compatibility

| Semantics | Status | AI SDK UI v7 chunks |
| --- | --- | --- |
| Message lifecycle | Supported | `start`, `finish` |
| Text | Supported | `text-start`, `text-delta`, `text-end` |
| Reasoning | Supported when exposed | `reasoning-start`, `reasoning-delta`, `reasoning-end` from normalized `reasoning_content` events |
| Tool input | Supported after assembly | `tool-input-available`; provider fragments are assembled by the Zhivex adapter before the portable event |
| Multiple tools | Supported | Tool identity is the provider-issued `toolCallId`; results update the matching call |
| Tool output/error | Supported | `tool-output-available`, `tool-output-error` |
| Tool approval | Supported | `tool-approval-request` / `tool-approval-response`; opaque IDs encode `provider + approvalRequestId` |
| Generated image/file | Supported | `file` with URL or bounded base64 data URL |
| Agent steps | Supported | `start-step`, `finish-step` |
| Agent lifecycle/provider data | Explicit degradation | Payload-free `data-zhivex-event` avoids exposing internal state |
| Unknown future event | Degrade or safe error | Default sends only `sourceType`; `unknownEvents: "error"` fails closed |
| Stream error | Safe by default | Public text is `Chat request failed.`; richer messages require an explicit `formatStreamError` |
| Client abort | Supported | Cancels the fetch and native async iterator; `request.signal` must be passed to Runner/provider execution |

## Transport and security limits

The compatibility transport reuses the bounded Zhivex fetch/SSE parser:

- request body: 1 MiB by default, configurable with `maxRequestBytes`;
- event: 1 MiB; undecoded line buffer: 2 MiB;
- response: 16 MiB and 10,000 events;
- total request timeout: 120 seconds; idle timeout: 30 seconds;
- HTTP error diagnostic body: 8 KiB;
- redirects: rejected by default;
- provider keys, response bodies, stack traces, arbitrary provider payloads, and
  full agent state are not emitted by default.

The server-side request parser separately bounds bytes, message count, part
count, and IDs. Application routes still own authentication, tenant isolation,
rate limits, URL/file policy, and per-part content limits.

## Verification

The repository includes:

- versioned golden protocol fixtures in `packages/react/tests/fixtures/ai-sdk-ui-v7`;
- bidirectional part and multiple-tool/fragment tests;
- limits, unknown-event, approval-identity, error-redaction, redirect, timeout,
  and abort regressions;
- a Happy DOM browser test that mounts the real `@ai-sdk/react` `useChat` hook;
- an executable page at `examples/next-runner/app/ai-sdk-ui/page.tsx`.

Run:

```bash
bun run test -- packages/react/tests/compat.test.ts packages/react/tests/compat-browser.test.ts
bun run typecheck
bun run docs:check
bun run build
```

Primary upstream references: [AI SDK UI transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport),
[stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol), and
[`useChat`](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat).
