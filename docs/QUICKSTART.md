# Quickstart

This guide gets a server-side multi-turn agent running with the RC package.

## Install

For the current release candidate:

```bash
bun add @zhivex-ai/sdk@next @zhivex-ai/openai
```

For stable installs after the RC is promoted:

```bash
bun add @zhivex-ai/sdk @zhivex-ai/openai
```

## Create A Runner

`Runner + SessionService` is the recommended first integration point. It wraps the existing agent runtime without replacing it, adds multi-turn context, and persists session events plus the latest resumable run state.

```ts
import { createAgent, createFileSessionService, createRunner } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const agent = createAgent({
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
