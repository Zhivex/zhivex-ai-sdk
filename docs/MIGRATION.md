# Migration Guide

Use this guide when moving an existing TypeScript AI integration to Zhivex without hiding production boundaries. Your application still owns auth, tenancy, billing, provider credentials, rate limits, tools, and stores.

## From Direct Provider SDKs

Keep provider setup explicit, then pass the provider model into the shared runtime:

```ts
import { createAgent, createProductionSafetyPolicy, createRunner, applySafetyPolicyToAgent } from "@zhivex-ai/sdk";
import { createPostgresSessionService } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const agent = applySafetyPolicyToAgent(
  createAgent({
    model: openai("gpt-4o-mini"),
    instructions: "Answer with product context."
  }),
  createProductionSafetyPolicy()
);

const runner = createRunner({
  appName: "support-api",
  agent,
  sessionService: createPostgresSessionService({ client: postgresClient })
});
```

Use `generateText()` for one-shot calls and `Runner + SessionService` for multi-turn product chat. Do not move provider keys, billing rules, workspace lookup, or DB clients into SDK-owned global state.

## From Vercel AI SDK Core Usage

Map model calls and tools to the Zhivex shared contracts:

```ts
import { generateText, tool } from "@zhivex-ai/sdk";
import { z } from "zod";

const weather = tool({
  name: "weather",
  description: "Looks up weather by city.",
  schema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, forecast: "sunny" })
});

const result = await generateText({
  model,
  prompt: "Weather in Madrid?",
  tools: { weather }
});
```

Zhivex keeps provider adapters separate from `@zhivex-ai/sdk`. Import only the provider packages your app uses, then rely on the shared message, tool, stream, object, and embedding contracts.

## From Simple Tool Loops

Replace custom loop state with `createAgent()` and `runAgent()`. Use `Runner` when the loop becomes a user-facing session.

```ts
import { createAgent, createProductionSafetyPolicy, applySafetyPolicyToAgent, runAgent, tool } from "@zhivex-ai/sdk";
import { z } from "zod";

const agent = applySafetyPolicyToAgent(
  createAgent({
    model,
    maxSteps: 6,
    tools: {
      lookupOrder: tool({
        name: "lookupOrder",
        description: "Loads order status.",
        schema: z.object({ orderId: z.string() }),
        execute: async ({ orderId }) => ({ orderId, status: "shipped" })
      })
    }
  }),
  createProductionSafetyPolicy()
);

const result = await runAgent(agent, {
  userId: currentUser.id,
  prompt: "Check order ord_123."
});
```

For production audits, attach `createProductionTraceCollector()` and export redacted summaries/tool-call audit records from server code. See [Production Guide](./PRODUCTION.md#observability-export-path).
