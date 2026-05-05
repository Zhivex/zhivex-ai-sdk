# Next Runner Example

This is a copy-paste reference for using `@zhivex-ai/sdk` from a Next.js App Router application.

The important boundary is:

```text
React client -> app/api/chat/route.ts -> Zhivex Runner -> provider + SessionService
```

Do not import provider-backed runners from browser components.

## Files

- `app/api/chat/route.ts`: server route that owns the SDK runner.
- `app/page.tsx`: minimal client UI that calls the route.

## Install

Inside a Next.js app:

```bash
bun add @zhivex-ai/sdk@next @zhivex-ai/openai
```

Set `OPENAI_API_KEY` on the server environment.

For production/serverless, replace the file-backed session service in the route with `createPostgresSessionService()`.
