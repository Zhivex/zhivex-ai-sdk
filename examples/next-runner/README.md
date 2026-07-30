# Next Runner Example

This is a copy-paste reference for using `@zhivex-ai/react` with a server-side `@zhivex-ai/sdk` Runner in a Next.js App Router application.

The important boundary is:

```text
@zhivex-ai/react -> app/api/chat/stream/route.ts -> Zhivex Runner
Zhivex Runner -> provider + SessionService -> UIMessageChunk SSE
```

Do not import provider-backed runners from browser components.

## Files

- `app/api/chat/route.ts`: server route that owns the SDK runner and returns a final JSON response.
- `app/api/chat/stream/route.ts`: server route that maps `Runner` events to safe UI SSE and finalizes the session.
- `app/layout.tsx`: imports the default `@zhivex-ai/react` stylesheet.
- `app/page.tsx`: customizable prebuilt chat UI driven by `useZhivexChat()`.

## Install

Inside a Next.js app:

```bash
bun add @zhivex-ai/react @zhivex-ai/sdk @zhivex-ai/openai react react-dom
```

Set `OPENAI_API_KEY` on the server environment.

For production/serverless, replace the file-backed session service in the route with `createPostgresSessionService()`.

The streaming route emits named SSE events:

```text
event: text-delta
data: {"type":"text-delta","messageId":"msg_123","role":"assistant","textDelta":"Hello"}

event: session-finish
data: {"type":"session-finish","sessionId":"sess_123","status":"completed"}
```

Keep provider credentials, tools, and stores in route handlers or other server-side code.
