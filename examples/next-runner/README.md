# Next Runner Starter

This is the standalone, executable end of the canonical Zhivex [Quickstart](../../docs/QUICKSTART.md). It takes one path from provider setup to first response, persistent `Runner` sessions, React, and bounded SSE.

## Run From A Clean Directory

Copy this folder outside the monorepo, then run:

```bash
cp .env.example .env
bun install
bun run first-response
bun run typecheck
bun run dev
```

For an existing Next.js application, the equivalent runtime install is:

```bash
bun add @zhivex-ai/react @zhivex-ai/sdk @zhivex-ai/openai react react-dom
```

Set `OPENAI_API_KEY` in `.env` before `bun run first-response`. The value remains server-side and `.env` is ignored by Git.

Open `http://localhost:3000`. The session ID shown in the header is persisted under `.zhivex/sessions`, so later turns use the same server-owned history.

The package manifest pins the versions certified with this starter. It has no workspace ranges or imports into `../../packages`, so copying it to an empty directory exercises published entrypoints rather than monorepo source.

## Architecture

```text
@zhivex-ai/react -> app/api/chat/stream/route.ts -> Zhivex Runner
Zhivex Runner -> OpenAI + SessionService -> UIMessageChunk SSE
```

- `scripts/first-response.ts`: bounded one-shot provider check.
- `lib/server.ts`: lazy server-only provider, `Agent`, `Runner`, budgets, timeout, and local persistence.
- `lib/http.ts`: bounded request reader, runtime validation helpers, no-store headers, and safe public errors.
- `app/api/chat/route.ts`: optional non-streaming JSON endpoint.
- `app/api/chat/stream/route.ts`: React/SSE endpoint with cancellation propagation.
- `app/page.tsx`: browser-safe chat UI with bounded fetch/SSE transport.
- `app/layout.tsx`: imports the default Zhivex React stylesheet.

## Safety Boundaries

- Request bodies are capped at 64 KiB; messages, session IDs, and approval batches have lower semantic limits.
- Provider calls and agent runs have explicit token, step, budget, and time limits.
- Browser cancellation reaches the runner through `request.signal`.
- Public failures omit provider response bodies and credentials.
- The local demo identity fails closed when `NODE_ENV=production`.

Before production, replace `resolveCurrentUserId()` with authenticated, tenant-scoped identity and replace the file session service with Postgres or another shared durable implementation. The application owns auth, tenancy, rate limiting, database lifecycle, and retention.

## Repository Gates

From the repository root:

```bash
bun run docs:check
bun run typecheck:examples
bun run smoke:packages
```

The package smoke installs candidate tarballs in an isolated consumer and emits a redacted `golden_path_installed_smoke` timing record. Set `ZHIVEX_GOLDEN_PATH_LIVE=1` only when intentionally running the bounded credentialed variant.
