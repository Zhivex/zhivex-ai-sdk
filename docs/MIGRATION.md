# Migration Guide

Use this guide when moving an existing TypeScript AI integration to Zhivex without hiding production boundaries. Your application still owns auth, tenancy, billing, provider credentials, rate limits, tools, and stores.

The long section below is the side-by-side path from Vercel AI SDK Core (the `ai` package) to Zhivex. It was checked against the public AI SDK reference on [ai-sdk.dev](https://ai-sdk.dev/docs/reference/ai-sdk-core) and against the Zhivex contracts in this repository. Names that look similar are not always the same option. Where a Vercel call has no Zhivex equivalent, the guide says so.

An offline script runs the Zhivex side of the main path without a provider key: [`examples/migration/from-vercel-ai-sdk.ts`](../examples/migration/from-vercel-ai-sdk.ts).

## From Vercel AI SDK Core Usage

Read this if the application imports `generateText`, `streamText`, `tool`, `embed`, `ToolLoopAgent`, or `useChat` from `ai` / `@ai-sdk/react`. Zhivex keeps the same function names for text generation, streaming, and embeddings. Provider setup, tool definitions, structured output, step limits, message parts, and durable sessions do not drop in unchanged.

`@zhivex-ai/react/compat` (beta) is the only supported way to keep an existing `useChat` hook. It is a transport boundary, not a reimplementation of AI SDK UI. The range exercised in this repo is `ai` `>=7.0.0 <8` and `@ai-sdk/react` `>=4.0.0 <5`. Details are in [AI SDK UI Compatibility](./AI_SDK_UI_COMPAT.md).

### Install

Remove the `ai` import from server code that you are moving. Keep `ai` and `@ai-sdk/react` installed when the UI still uses `useChat`.

```bash
bun add @zhivex-ai/sdk @zhivex-ai/openai zod
```

Add only the adapter packages you call. `@zhivex-ai/sdk` does not register providers for you. For the `useChat` transport (beta):

```bash
bun add @zhivex-ai/react ai@^7 @ai-sdk/react@^4
```

Server code stays on the server. Do not put provider keys in `NEXT_PUBLIC_` variables or in the browser bundle.

### What maps

| Vercel AI SDK Core | Zhivex |
| --- | --- |
| `generateText` from `ai` | `generateText` from `@zhivex-ai/sdk` |
| `streamText`, then `await result.text` | `streamText`, then `await result.collect()` |
| `instructions` on `generateText` / `streamText` | `system` on those calls. `instructions` is the agent field |
| `maxOutputTokens` | `maxTokens` |
| `stopWhen: isStepCount(n)` | `maxSteps: n`. Default for `generateText` and `streamText` is 1, same as `isStepCount(1)` |
| `Output.object({ schema })` inside `generateText` / `streamText` | `generateObject` / `streamObject` with `schema` and `mode` |
| `tool({ inputSchema, execute })`; the object key is the name | `tool({ name, schema, execute })`. The object key and `name` must be the same string |
| `createOpenAI` from `@ai-sdk/openai`, or a gateway string such as `"openai/gpt-6-astra"` | `createOpenAI({ apiKey })` from `@zhivex-ai/openai`, then `openai("gpt-6-astra")` |
| `embed` returns `{ embedding: number[] }` | `embed` returns `{ embeddings: number[][] }` |
| `embedMany({ values })` | `embed({ value })` or `embedMany` (same function), with one value or an array |
| `new ToolLoopAgent(...).generate()` | `new Agent(...).run()` or `runAgent()` |
| `WorkflowAgent` inside a workflow | `Runner` + `SessionService`, or an agent run store plus `resumeAgent()` |
| `useChat` from `@ai-sdk/react` | same hook, with `createAISDKUIChatTransport` from `@zhivex-ai/react/compat` (beta) |

### generateText and streamText

AI SDK Core defaults `stopWhen` to `isStepCount(1)` on `generateText` and `streamText`. Zhivex defaults `maxSteps` to 1. A tool call therefore does not continue into a final answer unless you raise the limit. `ToolLoopAgent` is different: its documented default is 20 steps. Set `maxSteps` explicitly when you port an agent.

`textStream` on both sides yields text deltas. On Zhivex, provider errors are reported by `eventStream` and `collect()`. Await `collect()` before treating a stream as successful. There is no `result.text` promise.

Vercel AI SDK Core:

```ts
import { generateText, streamText, isStepCount } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const generated = await generateText({
  model: openai("gpt-6-astra"),
  instructions: "Be concise.",
  prompt: "Where is order ord_123?",
  maxOutputTokens: 400,
  stopWhen: isStepCount(4),
  tools: { lookupOrder }
});

console.log(generated.text);

const streamed = streamText({
  model: openai("gpt-6-astra"),
  prompt: "Summarize the order in one sentence."
});

for await (const chunk of streamed.textStream) {
  process.stdout.write(chunk);
}

console.log(await streamed.text);
```

Zhivex:

```ts
import { generateText, streamText, tool } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const lookupOrder = tool({
  name: "lookupOrder",
  description: "Returns the status of one order.",
  schema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({ orderId, status: "shipped" })
});

const generated = await generateText({
  model: openai("gpt-6-astra"),
  system: "Be concise.",
  prompt: "Where is order ord_123?",
  maxTokens: 400,
  maxSteps: 4,
  tools: { lookupOrder }
});

console.log(generated.text);
console.log(generated.finishReason);
console.log(generated.toolResults);

const streamed = streamText({
  model: openai("gpt-6-astra"),
  prompt: "Summarize the order in one sentence."
});

for await (const chunk of streamed.textStream) {
  process.stdout.write(chunk);
}

const final = await streamed.collect();
console.log(final.text);
```

Messages are not interchangeable. AI SDK Core uses `content` on `ModelMessage` (`string` or an array of parts such as `{ type: "text", text }`). Zhivex uses `parts`:

```ts
import { assistant, system, user } from "@zhivex-ai/sdk";

const generated = await generateText({
  model: openai("gpt-6-astra"),
  messages: [
    system("Be concise."),
    user("Where is order ord_123?"),
    assistant("I will check that order.")
  ]
});
```

`generateText` does not accept AI SDK UI messages. Convert them at the edge you own, or use the compat request parser described in [AI SDK UI Compatibility](./AI_SDK_UI_COMPAT.md).

Other call-shape gaps on these two functions:

- `timeout: { totalMs, stepMs, toolMs }` does not exist. Use `timeoutMs` for one provider operation and `abortSignal` for cancellation. Agent runs can also set `policy.timeoutMs`.
- `topP`, `topK`, `presencePenalty`, `frequencyPenalty`, `stopSequences`, and `seed` are not shared `generateText` options. Pass provider-specific fields through `providerOptions` only when that adapter documents them.
- `prepareStep`, `activeTools`, `hasToolCall`, and `isLoopFinished` are not shared loop controls. The step ceiling is `maxSteps` (a positive integer or the explicit `"unlimited"` opt-in).
- `maxSteps` defaults to 1. Omitting it does not mean "run until the model stops calling tools".

Generation recipes: [Generation](./reference/GENERATION.md).

### Structured objects

Current AI SDK Core docs put structured output on `generateText` and `streamText` through `Output.object({ schema })`. That call can also use tools in the same request. Zhivex does not accept an `output` option on `generateText`. Use `generateObject` or `streamObject`. Both take a Zod `schema` and a `mode`.

`mode` is `"auto"`, `"native"`, or `"prompted"`. `"auto"` uses native structured output when `model.capabilities.structuredOutput` is true, and otherwise injects a schema prompt and validates locally. `"native"` throws `UnsupportedFeatureError` before the request when the model cannot do native structured output. Do not assume every adapter is native. The provider matrix in the [repository README](../README.md) is the list of JSON / schema behavior per provider.

Vercel AI SDK Core:

```ts
import { generateText, Output, streamText } from "ai";
import { z } from "zod";

const schema = z.object({
  orderId: z.string(),
  status: z.enum(["processing", "shipped", "delivered"])
});

const generated = await generateText({
  model: openai("gpt-6-astra"),
  output: Output.object({ schema }),
  prompt: "Return the order status."
});

console.log(generated.output);

const streamed = streamText({
  model: openai("gpt-6-astra"),
  output: Output.object({ schema }),
  prompt: "Return the order status."
});

for await (const partial of streamed.partialOutputStream) {
  console.log(partial);
}
```

Zhivex:

```ts
import { generateObject, streamObject } from "@zhivex-ai/sdk";
import { z } from "zod";

const schema = z.object({
  orderId: z.string(),
  status: z.enum(["processing", "shipped", "delivered"])
});

const generated = await generateObject({
  model: openai("gpt-6-astra"),
  schema,
  mode: "auto",
  schemaName: "order_status",
  prompt: "Return the order status."
});

console.log(generated.object);
console.log(generated.objectMode);

const streamed = streamObject({
  model: openai("gpt-6-astra"),
  schema,
  mode: "native",
  schemaName: "order_status",
  prompt: "Return the order status."
});

for await (const partial of streamed.partialObjectStream) {
  console.log(partial);
}

const final = await streamed.collect();
console.log(final.object);
```

`generateObject` / `streamObject` accept the same tool and `maxSteps` fields as `generateText`, because they build on that request. The object is parsed from the final text. Partial objects from `partialObjectStream` are incomplete and are not schema-valid until `collect()` resolves.

Agents that should finish on a typed value use `outputSchema` and `outputMode` (`"auto"`, `"native"`, or `"prompted"`) and read `result.finalOutput`. That is separate from `generateObject`. See [Agents](./AGENTS.md).

### Tools

`tool()` on both sides is a TypeScript helper around a definition you pass through. The field names differ, and Zhivex also requires an explicit `name`.

Vercel AI SDK Core, from the [tool reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool):

```ts
import { generateText, tool } from "ai";
import { z } from "zod";

const result = await generateText({
  model: openai("gpt-6-astra"),
  tools: {
    lookupOrder: tool({
      description: "Returns the status of one order.",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => ({ orderId, status: "shipped" })
    })
  },
  stopWhen: isStepCount(4),
  prompt: "Where is order ord_123?"
});
```

The object key is the tool name. `execute` receives AI SDK `ToolExecutionOptions` as the second argument (`toolCallId`, `messages`, `abortSignal`, and other fields). `needsApproval` still works there and is documented as deprecated in favor of `toolApproval` on the generate call.

Zhivex:

```ts
import { generateText, tool } from "@zhivex-ai/sdk";
import { z } from "zod";

const result = await generateText({
  model: openai("gpt-6-astra"),
  maxSteps: 4,
  tools: {
    lookupOrder: tool({
      name: "lookupOrder",
      description: "Returns the status of one order.",
      schema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }, context) => ({
        orderId,
        status: "shipped",
        signal: context?.abortSignal?.aborted === true
      })
    })
  },
  prompt: "Where is order ord_123?"
});

console.log(result.text);
console.log(result.toolResults);
```

The tools-object key and `name` must match. Adapters send `name` to the provider. The local loop looks the call up by that same string. A key of `lookupOrder` with `name: "get_order"` will not execute.

`execute` may take a second `ToolExecutionContext`. Forward `context.abortSignal` and, for side effects, `context.idempotencyKey`. There is no `onInputStart` / `onInputDelta` callback: tool calls are completed before the local tool runs. JSON Schema tools are not a shared alternative to Zod on this helper.

Approval is not the AI SDK `toolApproval` object. For a local tool that must pause before it runs, set `requiresApproval: true` and `approvalMode: "interrupt"`, then resume the agent run with the pending approval. That path is part of the stable agent runtime. `createAgentApprovalQueue()` is also classified stable and turns pending requests into app-owned queue items; it does not authorize an HTTP caller by itself. See [Agents](./AGENTS.md) and [Tools](./reference/TOOLS.md).

Provider-hosted tools (web search, code execution, remote MCP, and similar) are adapter helpers such as `openAIWebSearchTool` or `anthropicWebSearchTool`. They are not portable across every provider. Unsupported combinations throw before the request.

### Providers and adapters

AI SDK Core calls often take either a provider factory (`openai("gpt-6-astra")` from `@ai-sdk/openai`) or a gateway model string (`"anthropic/claude-sonnet-5.5"`). Zhivex calls take a `LanguageModel` from an adapter package. There is no default gateway string in `generateText`.

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

await generateText({ model: openai("gpt-6-astra"), prompt: "Hello" });
await generateText({ model: anthropic("claude-opus-5"), prompt: "Hello" });
```

`createModelResolver()` (beta), from `@zhivex-ai/sdk/beta`, is an optional `provider/model` lookup in front of adapters you configure. It does not replace those adapters. See [Optional Model Resolver (Beta)](./MODEL_RESOLVER.md).

Tiers describe how much of the agent surface an adapter covers. They are not a quality score. Tier C means basic tool loops, not full agent support. The matrix in the [repository README](../README.md) is the source of truth; this is the current split:

| Adapter package | Tier |
| --- | --- |
| `@zhivex-ai/openai`, `@zhivex-ai/azure-openai` | Tier A |
| `@zhivex-ai/bedrock` with `runtime: "openai"` | Tier A |
| `@zhivex-ai/xai`, `@zhivex-ai/meta`, `@zhivex-ai/anthropic`, `@zhivex-ai/gemini`, `@zhivex-ai/vertex`, `@zhivex-ai/qwen`, `@zhivex-ai/deepseek`, `@zhivex-ai/zai` | Tier B |
| `@zhivex-ai/openrouter`, `@zhivex-ai/kimi`, `@zhivex-ai/ollama` | basic (Tier C) |
| `@zhivex-ai/bedrock` Converse | basic (Tier C) |

Factories you will import: `createOpenAI`, `createAzureOpenAI`, `createBedrock`, `createXAI`, `createMeta`, `createAnthropic`, `createGemini`, `createVertex`, `createQwen`, `createDeepSeek`, `createZAI`, `createOpenRouter`, `createKimi`, `createOllama`.

Many provider packages that exist in the AI SDK catalog do not have a Zhivex adapter. OpenRouter can reach some of those models and is basic (Tier C). A missing capability throws `UnsupportedFeatureError` instead of being ignored.

`@zhivex-ai/gateway` is a separate routing layer with fallbacks between adapters you already configured. It is not the Vercel AI Gateway and it does not accept `"provider/model"` strings by itself.

### Embeddings

`embed` exists on both sides. The result shape and the batch helper do not match.

Vercel AI SDK Core, from the [embeddings guide](https://ai-sdk.dev/docs/ai-sdk-core/embeddings):

```ts
import { cosineSimilarity, embed, embedMany } from "ai";

const single = await embed({
  model: openai.embeddingModel("text-embedding-3-small"),
  value: "order shipped",
  dimensions: 256
});

const batch = await embedMany({
  model: openai.embeddingModel("text-embedding-3-small"),
  values: ["order shipped", "order delayed"],
  maxParallelCalls: 2
});

console.log(single.embedding.length);
console.log(cosineSimilarity(batch.embeddings[0], batch.embeddings[1]));
```

Zhivex:

```ts
import { cosineSimilarity, embed, embedMany } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const embeddingModel = openai.embeddingModel?.("text-embedding-3-small");
if (!embeddingModel) {
  throw new Error("This adapter does not expose an embedding model.");
}

const single = await embed({
  model: embeddingModel,
  value: "order shipped"
});

const batch = await embedMany({
  model: embeddingModel,
  value: ["order shipped", "order delayed"]
});

console.log(single.embeddings[0]?.length);
console.log(cosineSimilarity(batch.embeddings[0] ?? [], batch.embeddings[1] ?? []));
```

`embedMany` is the same function as `embed`. One call sends every value on that model’s `embed()` request. There is no `maxParallelCalls` and no top-level `dimensions`. `value` may be a string or an array. The vectors always come back as `embeddings: number[][]`, together with the `values` you passed. `cosineSimilarity` is stable and throws if the vectors differ in length.

Not every adapter implements `embeddingModel`. The OpenAI embedding request in this repo sends `model` and `input`. It does not forward a dimensions override. Multimodal embedding values are rejected by that OpenAI adapter; other adapters document their own input types.

### Agent and tool loops

`ToolLoopAgent` wraps the same settings as `generateText` / `streamText`, including `stopWhen`. Zhivex `Agent` wraps the shared tool loop and returns a serializable run (`status`, `outputText`, `state`, `toolResults`, `steps`). A fresh agent run also defaults to one step. Port `stopWhen: isStepCount(20)` to `maxSteps: 20`, not to an omitted field.

Vercel AI SDK Core, from [ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent):

```ts
import { isStepCount, ToolLoopAgent } from "ai";

const agent = new ToolLoopAgent({
  model: openai("gpt-6-astra"),
  instructions: "Use lookupOrder before answering about an order.",
  tools: { lookupOrder },
  stopWhen: isStepCount(4)
});

const result = await agent.generate({
  prompt: "Where is order ord_123?"
});

console.log(result.text);
```

Zhivex:

```ts
import { Agent, tool } from "@zhivex-ai/sdk";
import { z } from "zod";

const agent = new Agent({
  model: openai("gpt-6-astra"),
  instructions: "Use lookupOrder before answering about an order.",
  maxSteps: 4,
  tools: {
    lookupOrder: tool({
      name: "lookupOrder",
      description: "Returns the status of one order.",
      schema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => ({ orderId, status: "shipped" })
    })
  }
});

const result = await agent.run({
  prompt: "Where is order ord_123?"
});

console.log(result.status);
console.log(result.outputText);
console.log(result.state);
```

`createAgent()` and `runAgent()` are the functional form of the same runtime. `@zhivex-ai/agents` is a smaller facade over that runtime when you do not need `Runner`, workflows, or embeddings.

`agent.stream()` returns `textStream` plus `collect()`, and it also emits agent lifecycle events. That stream is not an AI SDK UI message stream. For `useChat`, use the compat transport (beta) below.

There is no `prepareStep` hook. `maxSteps: "unlimited"` removes the cumulative step ceiling until some other stop (a final answer, approval, cancellation, or another explicit budget). It is an opt-in, and older readers of saved runs do not understand that literal.

### Durable sessions

[WorkflowAgent](https://ai-sdk.dev/docs/agents/workflow-agent) (`@ai-sdk/workflow`) is a durable agent loop that runs inside a workflow. Each tool call can be a workflow step, and approval can survive that boundary. Zhivex does not host that workflow runtime. Durability here is a library store your process opens.

Use `Runner` and a `SessionService` for multi-turn product chat. The runner appends session events and keeps the latest resumable agent state. Built-in services:

- `createInMemorySessionService()` for tests
- `createFileSessionService({ directory })` for a single machine
- `createSqliteSessionService({ db })` with a SQLite driver you pass in (`db.exec` plus `db.prepare` or `db.query`, including `bun:sqlite`)
- `createPostgresSessionService({ client })` with a Postgres client you pass in (`query(sql, params)`)

```ts
import { Agent, createFileSessionService, createRunner } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const runner = createRunner({
  appName: "support-api",
  agent: new Agent({
    model: openai("gpt-6-astra"),
    instructions: "Use tools when they help.",
    maxSteps: 4
  }),
  sessionService: createFileSessionService({
    directory: ".zhivex/sessions"
  })
});

const first = await runner.run({
  userId: currentUser.id,
  sessionId: "order-ord_123",
  prompt: "Where is order ord_123?"
});

const second = await runner.run({
  userId: currentUser.id,
  sessionId: first.session.sessionId,
  prompt: "Thanks"
});

console.log(second.output.outputText);
console.log(second.session.events.map((event) => event.type));
```

The Postgres client, schema migrations beyond the service’s own table, credentials, and tenant checks stay in the application. Pass `expectedRevision` when you want a conflict instead of last-write-wins.

A single agent run, as opposed to a chat session, can use a run store on the agent (`createFileAgentRunStore`, `createSqliteAgentRunStore`, `createPostgresAgentRunStore`) and continue with `agent.resume()` or `resumeAgent()`. That state includes messages, tool results, and pending approvals. It is not a workflow engine.

Local human approval pauses a run at `status: "waiting_approval"`. Resume it with the pending request ids. This is the stable agent contract. It is a different protocol from `WorkflowAgent` tool approval, and it does not run inside the Workflow DevKit. The queue helper and the resume path are documented in [Agents](./AGENTS.md).

### useChat (beta)

Keep `useChat` from `@ai-sdk/react`. Point it at a Zhivex route with `createAISDKUIChatTransport` from `@zhivex-ai/react/compat` (beta). The reducer and your message components stay. Providers, tools, credentials, and session state stay on the server.

```tsx
"use client";

import { useChat } from "@ai-sdk/react";
import { createAISDKUIChatTransport } from "@zhivex-ai/react/compat";
import { useMemo } from "react";

export function Chat() {
  const transport = useMemo(
    () => createAISDKUIChatTransport({
      endpoint: "/api/chat/stream"
    }),
    []
  );

  const { messages, sendMessage } = useChat({ transport });
  return null;
}
```

The default request body is one new user message plus `sessionId`. The server `Runner` is the history. Regeneration is off unless you opt in with a body builder that can do it without duplicating the session. The executable page in this repo is [`examples/next-runner/app/ai-sdk-ui/page.tsx`](../examples/next-runner/app/ai-sdk-ui/page.tsx). The server can instead emit the AI SDK UI stream for `DefaultChatTransport`; that parser and the part-by-part table are in [AI SDK UI Compatibility](./AI_SDK_UI_COMPAT.md).

`@zhivex-ai/react` also ships a separate headless chat UI. That is a different client from `useChat`, covered by the [Next.js guide](./NEXTJS.md).

### End-to-end example

The snippet below is the server path this guide maps: one tool, a bounded tool loop, a structured object, embeddings, and a second turn on a file-backed session. Swap the model line for another adapter when you want a different provider. The same steps run offline, with a local model double, in [`examples/migration/from-vercel-ai-sdk.ts`](../examples/migration/from-vercel-ai-sdk.ts):

```bash
bun run examples/migration/from-vercel-ai-sdk.ts
```

```ts
import {
  Agent,
  cosineSimilarity,
  createFileSessionService,
  createRunner,
  embed,
  generateObject,
  generateText,
  streamText,
  tool
} from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = openai("gpt-6-astra");

const lookupOrder = tool({
  name: "lookupOrder",
  description: "Returns the status of one order.",
  schema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }, context) => {
    context?.abortSignal?.throwIfAborted();
    return { orderId, status: orderId === "ord_123" ? "shipped" : "unknown" };
  }
});

const answered = await generateText({
  model,
  system: "Use lookupOrder before answering about an order.",
  prompt: "Where is order ord_123?",
  tools: { lookupOrder },
  maxSteps: 4
});

const streamed = streamText({
  model,
  prompt: `Summarize this in one sentence: ${answered.text}`
});
const summary = await streamed.collect();

const extracted = await generateObject({
  model,
  schema: z.object({
    orderId: z.string(),
    status: z.enum(["processing", "shipped", "delivered"])
  }),
  mode: "auto",
  schemaName: "order_status",
  prompt: `Extract the order from this text: ${summary.text}`
});

const embeddingModel = openai.embeddingModel?.("text-embedding-3-small");
if (!embeddingModel) {
  throw new Error("OpenAI adapter did not expose an embedding model.");
}
const embedded = await embed({
  model: embeddingModel,
  value: extracted.object.status
});

const runner = createRunner({
  appName: "order-status",
  agent: new Agent({
    model,
    instructions: "Use lookupOrder before answering about an order.",
    maxSteps: 4,
    tools: { lookupOrder }
  }),
  sessionService: createFileSessionService({ directory: ".zhivex/sessions" })
});

const first = await runner.run({
  userId: "user_123",
  sessionId: "order-ord_123",
  prompt: "Where is order ord_123?"
});
const second = await runner.run({
  userId: "user_123",
  sessionId: first.session.sessionId,
  prompt: "Thanks"
});

console.log(extracted.object, embedded.embeddings[0]?.length);
console.log(cosineSimilarity(embedded.embeddings[0] ?? [], embedded.embeddings[0] ?? []));
console.log(second.output.outputText);
```

`useChat` (beta) is the browser half of this path. Wire it with the transport in the previous section and a server route that calls `runner.stream()`. The Next.js starter shows that route shape: [Next.js guide](./NEXTJS.md).

### What does not map

Stay on Vercel AI SDK when the feature you need is one of the gaps below. Zhivex does not cover the AI SDK provider catalog, and it does not host the Workflow DevKit.

- **Provider catalog and gateway strings.** Most `@ai-sdk/*` providers have no Zhivex adapter. Gateway model strings such as `"anthropic/claude-sonnet-5.5"` are not a `generateText` model. `createModelResolver()` (beta) only resolves adapters you configure. OpenRouter is basic (Tier C).
- **AI SDK UI beyond the beta transport.** `useChat` works only through `@zhivex-ai/react/compat` (beta), on the `ai` 7 / `@ai-sdk/react` 4 range above. `useObject`, generative UI, and React Server Components helpers such as `streamUI` have no counterpart here. Some UI message parts are preserved as tagged provider data and are not model input; the table is in [AI SDK UI Compatibility](./AI_SDK_UI_COMPAT.md).
- **WorkflowAgent.** Durable human approval inside a Vercel workflow does not move onto `createPostgresSessionService`. Zhivex sessions and run stores are tables your process reads. They are not a workflow runtime. Vercel, Mastra, and the OpenAI Agents SDK also document durable human-in-the-loop. The Zhivex pause/resume path is the stable agent contract; it is a different API (`requiresApproval`, `approvalMode: "interrupt"`, `resume` / `resumeAgent`).
- **Loop control.** There is no `stopWhen`, `hasToolCall`, `isLoopFinished`, or `prepareStep`. `generateText`, `streamText`, and `Agent` stop after one step unless you set `maxSteps`. `ToolLoopAgent`’s default of 20 steps will not carry over if you only rename the class.
- **Structured output combined with tools in one `generateText`.** `Output.object`, `Output.array`, and `Output.json` are not options on `generateText`. Use `generateObject` / `streamObject`, or `outputSchema` on an agent.
- **Tool surface.** No `inputSchema` field, no JSON Schema `tool()` input, no dynamic tool type, no `onInputStart` / `onInputDelta` / `onInputAvailable`, no `toolsContext` / `runtimeContext`, and no `activeTools` mask. The second `execute` argument is Zhivex’s tool context.
- **Embeddings.** No top-level `dimensions`, no `headers`, no `maxParallelCalls`, and `embed` does not return a singular `embedding`. `embedMany` does not batch in parallel. The OpenAI adapter does not send a dimensions override.
- **MCP stdio.** The stable MCP client is Streamable HTTP plus OAuth (`@zhivex-ai/sdk/mcp-http`). `createMcpToolRegistry` is beta. There is no stdio transport in the SDK. See [MCP HTTP](./MCP_HTTP.md).
- **Browser calls with a client API key.** The SDK is server-first. A browser should call your route.
- **Call options that are provider-specific on AI SDK Core** (`topP`, `topK`, penalties, `stopSequences`, `seed`, telemetry record flags, smoothStream / experimental stream transforms) are not shared Zhivex arguments. Adapter `providerOptions` cover only what that adapter implements.
- **Message wire format.** `content` does not replace `parts`. Copying AI SDK `ModelMessage` JSON into `generateText` will fail validation.

`getApiStability("generateText")` returns `{ symbol, stability }`, and `listApiStability()` lists every classified export. `stability` is `stable`, `beta`, or `experimental`. An unknown name returns `undefined`. Prefer that manifest over this guide when an export’s status changes.

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
