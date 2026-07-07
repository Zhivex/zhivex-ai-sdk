# Next Runner Example

This is a copy-paste reference for using `@zhivex-ai/sdk` from a Next.js App Router application.

The important boundary is:

```text
React client -> app/api/chat/route.ts -> Zhivex Runner -> provider + SessionService
React client -> app/api/chat/stream/route.ts -> runner.stream() -> incremental NDJSON events
```

Do not import provider-backed runners from browser components.

## Files

- `app/api/chat/route.ts`: server route that owns the SDK runner and returns a final JSON response.
- `app/api/chat/stream/route.ts`: server route that streams incremental text events and a final session id.
- `app/page.tsx`: minimal client UI that calls the streaming route.

## Install

Inside a Next.js app:

```bash
bun add @zhivex-ai/sdk@next @zhivex-ai/openai
```

Set `OPENAI_API_KEY` on the server environment.

For production/serverless, replace the file-backed session service in the route with `createPostgresSessionService()`.

The streaming route emits newline-delimited JSON:

```json
{"type":"text","text":"partial answer"}
{"type":"finish","sessionId":"sess_123","status":"completed"}
```

Keep provider credentials, tools, and stores in route handlers or other server-side code.
