# Quickstart

This guide gets a server-side multi-turn agent running with the stable package.

For the full agent surface, including tools, approvals, streaming, stores, evaluation, and provider routing, see [Agents Guide](./AGENTS.md).

## Install

For the current stable release:

```bash
bun add @zhivex-ai/sdk @zhivex-ai/openai
```

For prerelease validation:

```bash
bun add @zhivex-ai/sdk@next @zhivex-ai/openai
```

## Create An Agent

`Agent` is the stable agent-first entry point. It keeps reusable model settings, instructions, tools, safety, memory, and operational defaults in one place.

```ts
import { Agent, tool } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const agent = new Agent({
  model: openai("gpt-4o-mini"),
  instructions: "You are a concise product assistant.",
  maxSteps: 3,
  tools: {
    lookupDocs: tool({
      name: "lookupDocs",
      schema: z.object({ query: z.string() }),
      execute: async ({ query }) => ({ query, answer: "Use Runner for multi-turn app sessions." })
    })
  }
});

const result = await agent.run({
  prompt: "What should I use for a multi-turn app?"
});

console.log(result.outputText);
console.log(result.state);
```

Use `agent.stream()` for lifecycle/text streaming and `agent.resume()` when a saved run state is waiting for approvals. The functional `createAgent()` / `runAgent()` API remains available for plain-object definitions and existing integrations.

## Create A Runner

`Runner + SessionService` is the recommended first integration point. It wraps the existing agent runtime without replacing it, adds multi-turn context, and persists session events plus the latest resumable run state.

```ts
import { Agent, createFileSessionService, createRunner } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const agent = new Agent({
  model: openai("gpt-4o-mini"),
  instructions: "You are a concise product assistant."
});

const runner = createRunner({
  appName: "quickstart",
  agent,
  sessionService: createFileSessionService({
    directory: "./tmp/agent-sessions"
  })
});

const first = await runner.run({
  userId: "user_123",
  sessionId: "demo",
  prompt: "Remember that I prefer short answers."
});

const second = await runner.run({
  userId: "user_123",
  sessionId: first.session.sessionId,
  prompt: "Explain what this SDK is for."
});

console.log(second.output.outputText);
console.log(second.session.events.map((event) => event.type));
```

## Pick The Right Store

Use in-memory stores for tests and short-lived local scripts.

Use file-backed stores for local development, demos, and CLI inspection.

Use Postgres or SQLite stores when a process restart must preserve sessions. For serverless production, prefer Postgres because file systems are usually ephemeral and not shared across instances.

```ts
import { createPostgresSessionService } from "@zhivex-ai/sdk";

const sessionService = createPostgresSessionService({
  client: postgresClient
});
```

## React And Browser Apps

Do not import provider-backed runners directly into browser React. Provider keys, tool execution, database clients, and durable stores must stay on the server.

Use this shape instead:

```text
React client -> fetch("/api/chat") -> server route -> createRunner().run()
```

See [Next.js Runner Guide](./NEXTJS.md) for a complete route-handler example.

## Stability

- `Runner + SessionService`: Stable
- Declarative workflows: Beta
- Artifacts: Beta
- Workflow state services: Beta
- CLI: Beta

Check a runtime symbol directly:

```ts
import { getApiStability } from "@zhivex-ai/sdk";

console.log(getApiStability("createRunner"));
```
