# Quickstart

This is the canonical Zhivex adoption path: install one provider, get the first response, add a persistent `Runner`, then connect the same server-side runner to React. It is intentionally narrower than the full API surface.

Target time from a clean project:

- first provider response: under 5 minutes;
- persistent chat with UI: under 15 minutes when starting from the provided starter.

For advanced tools, approvals, routing, evaluation, and workflows, continue with the [Agents Guide](./AGENTS.md) after this path works.

## 1. Install

You need Bun 1.3.7 or newer and an OpenAI API key. Keep the key in the server environment; never expose it through a `NEXT_PUBLIC_` variable or browser code.

```bash
mkdir zhivex-quickstart
cd zhivex-quickstart
bun init -y
bun add @zhivex-ai/sdk @zhivex-ai/openai
```

Create `.env` and keep it out of source control:

```dotenv
OPENAI_API_KEY=
```

## 2. Get The First Response

Create `first-response.ts`:

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error("Set OPENAI_API_KEY in .env before running the first-response script.");
}

const openai = createOpenAI({ apiKey });
const startedAt = performance.now();
const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Reply with one short sentence confirming that Zhivex AI SDK is connected.",
  maxTokens: 64,
  timeoutMs: 30_000
});

console.log(result.text);
console.log(`FIRST_RESPONSE_OK ${Math.round(performance.now() - startedAt)}ms`);
```

Run it:

```bash
bun run first-response.ts
```

`timeoutMs` bounds the provider call. Application cancellation can also be passed through `abortSignal` when the caller already owns an `AbortController` or request signal.

## 3. Add A Persistent Agent

Replace the one-shot script with `runner.ts`:

```ts
import {
  Agent,
  createFileSessionService,
  createRunner
} from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY in .env.");

const agent = new Agent({
  model: createOpenAI({ apiKey })("gpt-4o-mini"),
  instructions: "You are a concise product assistant.",
  maxSteps: 4,
  maxTokens: 512,
  policy: {
    timeoutMs: 60_000,
    onTimeout: "cancel-requested",
    budget: {
      maxSteps: 4,
      maxToolCalls: 4,
      maxOutputTokens: 2_048,
      maxTotalTokens: 8_192
    }
  }
});

const sessionService = createFileSessionService({
  directory: ".zhivex/sessions"
});
const runner = createRunner({
  appName: "quickstart",
  agent,
  sessionService
});

const first = await runner.run({
  userId: "user_123",
  sessionId: "demo",
  prompt: "Remember that I prefer short answers."
});
const second = await runner.run({
  userId: "user_123",
  sessionId: first.session.sessionId,
  prompt: "What answer format do I prefer?"
});

console.log(second.output.outputText);
console.log(second.session.events.map((event) => event.type));
```

Run it with `bun run runner.ts`. The file-backed service persists session state across process restarts and is appropriate for local development. Use `createPostgresSessionService()` for shared or serverless production state.

## 4. Connect React

Install the browser-safe React package and use the [standalone Next.js starter](../examples/next-runner/README.md):

```bash
bun add @zhivex-ai/react react react-dom
```

The boundary stays the same:

```text
React client -> /api/chat/stream -> Runner -> provider + SessionService
```

The browser imports only `@zhivex-ai/react`. Provider credentials, `Runner`, tools, session stores, authorization, limits, and tenant identity stay in the server route. See the [Next.js Runner Guide](./NEXTJS.md) for the route and transport shape used by the starter.

## 5. Verify The Installed Path

The repository package smoke packs the candidate packages, installs them in an isolated consumer, and runs the canonical flow under Bun without workspace imports:

```bash
bun run smoke:packages
```

It emits a redacted `golden_path_installed_smoke` JSON record with first-response and persistent-chat timings. To add a bounded live OpenAI run to the same installed-tarball smoke, provide server-side credentials and opt in explicitly:

```bash
ZHIVEX_GOLDEN_PATH_LIVE=1 bun run smoke:packages
```

The deterministic smoke proves packaging, public entrypoints, persistence, and React transport availability. Only the opt-in credentialed mode is live-provider evidence. Neither mode logs the API key or response text.

For a first-time-user timing trial and the evidence format, use [Golden Path Verification](./maintainers/GOLDEN_PATH_VERIFICATION.md).

## Errors And Production Boundaries

- Show generic public errors; keep bounded provider diagnostics in server-side telemetry.
- Forward `request.signal` so browser cancellation reaches the agent run.
- Bound request bodies, message length, session identifiers, output tokens, total run time, steps, tool calls, and retained stream data.
- Authentication, authorization, tenant isolation, rate limiting, database clients, and retention are application-owned.
- Never use the starter's local demo identity or file-backed sessions in a multi-user production deployment.
