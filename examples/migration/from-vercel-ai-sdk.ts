/**
 * End-to-end Zhivex shape for a Vercel AI SDK Core migration.
 *
 * This file runs offline. The language model and embedding model are local
 * doubles, so `bun run examples/migration/from-vercel-ai-sdk.ts` does not call
 * a provider. Application code uses the same functions with an adapter:
 *
 *   import { createOpenAI } from "@zhivex-ai/openai";
 *   const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
 *   const model = openai("gpt-6-astra");
 *
 * The side-by-side mapping lives in docs/MIGRATION.md. This checkout imports
 * workspace source so the script runs before `dist/` is packed.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  Agent,
  cosineSimilarity,
  createFileSessionService,
  createRunner,
  embed,
  embedMany,
  generateText,
  getApiStability,
  streamObject,
  tool,
  type LanguageModel,
  type ModelCapabilities,
  type ModelMessage
} from "../../packages/sdk/src/index";
import { z } from "zod";

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const baseCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false
} satisfies ModelCapabilities;

const textOf = (messages: readonly ModelMessage[]): string =>
  messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const lastUserText = (messages: readonly ModelMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return textOf([message]);
    }
  }
  return "";
};

const orderSchema = z.object({
  orderId: z.string(),
  status: z.enum(["processing", "shipped", "delivered"])
});

const lookupOrder = tool({
  name: "lookupOrder",
  description: "Returns the status of one order.",
  schema: z.object({
    orderId: z.string()
  }),
  execute: async ({ orderId }) => ({
    orderId,
    status: orderId === "ord_123" ? "shipped" : "unknown"
  })
});

const model: LanguageModel = {
  provider: "example",
  modelId: "migration-local",
  capabilities: baseCapabilities,
  async generate(input) {
    if (input.structuredOutput) {
      const object = { orderId: "ord_123", status: "shipped" };
      return {
        text: JSON.stringify(object),
        finishReason: "stop",
        messages: [{ role: "assistant", parts: [{ type: "text", text: JSON.stringify(object) }] }]
      };
    }

    const latest = input.messages.at(-1);
    if (latest?.role === "tool") {
      return {
        text: "Order ord_123 is shipped.",
        finishReason: "stop",
        messages: [{ role: "assistant", parts: [{ type: "text", text: "Order ord_123 is shipped." }] }]
      };
    }

    const prompt = lastUserText(input.messages);
    if (input.tools && prompt.includes("ord_123")) {
      return {
        finishReason: "tool-calls",
        messages: [{
          role: "assistant",
          parts: [{
            type: "tool-call",
            toolCall: {
              id: "call_lookup_order",
              name: "lookupOrder",
              input: { orderId: "ord_123" }
            }
          }]
        }]
      };
    }

    return {
      text: `Noted: ${prompt}`,
      finishReason: "stop",
      messages: [{ role: "assistant", parts: [{ type: "text", text: `Noted: ${prompt}` }] }]
    };
  },
  async stream(input) {
    const generated = await this.generate(input);
    const text = generated.text ?? textOf(generated.messages ?? []);
    return (async function* () {
      if (text) {
        yield { type: "text-delta" as const, textDelta: text };
      }
      yield { type: "finish" as const, finishReason: generated.finishReason ?? "stop" };
    })();
  }
};

const vector = (value: string): number[] => {
  const coordinates = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let index = 0; index < value.length; index += 1) {
    coordinates[index % coordinates.length] += value.charCodeAt(index);
  }
  return coordinates;
};

const embeddingModel = {
  provider: "example",
  modelId: "migration-embed",
  capabilities: { ...baseCapabilities, tools: false, structuredOutput: false, embeddings: true },
  async embed(input: { values: ReadonlyArray<string | { mediaType: string }> }) {
    return {
      embeddings: input.values.map((value) => {
        if (typeof value !== "string") {
          throw new Error("This local embedding double accepts text only.");
        }
        return vector(value);
      })
    };
  }
};

const tools = { lookupOrder };

const stability = {
  generateText: getApiStability("generateText"),
  streamObject: getApiStability("streamObject"),
  embed: getApiStability("embed"),
  Agent: getApiStability("Agent"),
  createRunner: getApiStability("createRunner")
};
for (const [symbol, entry] of Object.entries(stability)) {
  assert(entry?.stability === "stable", `${symbol} is ${entry?.stability ?? "unclassified"}.`);
}
console.log("stability", stability);

const generated = await generateText({
  model,
  system: "Answer with the tool result.",
  prompt: "Where is order ord_123?",
  tools,
  maxSteps: 3
});
assert(generated.text === "Order ord_123 is shipped.", `generateText text: ${generated.text}`);
assert(generated.toolResults[0]?.toolName === "lookupOrder", "generateText did not call lookupOrder.");
assert(generated.steps.length === 2, `generateText steps: ${generated.steps.length}`);

const streamed = streamObject({
  model,
  prompt: "Return the order status.",
  schema: orderSchema,
  mode: "native",
  schemaName: "order_status"
});
let sawPartial = false;
for await (const partial of streamed.partialObjectStream) {
  if (partial.orderId === "ord_123") {
    sawPartial = true;
  }
}
const objectResult = await streamed.collect();
assert(sawPartial, "streamObject did not emit the order id.");
assert(objectResult.object.status === "shipped", "streamObject status was not shipped.");
assert(objectResult.objectMode === "native", `object mode: ${objectResult.objectMode}`);

const embedded = await embed({
  model: embeddingModel,
  value: "order shipped"
});
const embeddedMany = await embedMany({
  model: embeddingModel,
  value: ["order shipped", "order delayed"]
});
assert(embedded.embeddings.length === 1, "embed did not return one vector.");
assert(embeddedMany.embeddings.length === 2, "embedMany did not return two vectors.");
assert(cosineSimilarity(embedded.embeddings[0]!, embeddedMany.embeddings[0]!) === 1, "identical text was not similar.");
assert(cosineSimilarity(embeddedMany.embeddings[0]!, embeddedMany.embeddings[1]!) < 1, "different text was identical.");

const agent = new Agent({
  id: "order-status",
  model,
  instructions: "Use lookupOrder before answering about an order.",
  maxSteps: 4,
  tools
});
const runner = createRunner({
  appName: "migration-example",
  agent,
  sessionService: createFileSessionService({
    directory: await mkdtemp(path.join(os.tmpdir(), "zhivex-vercel-migration-"))
  })
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

assert(first.output.outputText === "Order ord_123 is shipped.", `runner text: ${first.output.outputText}`);
assert(second.output.outputText === "Noted: Thanks", `runner follow-up: ${second.output.outputText}`);
assert(second.session.events.some((event) => event.type === "user-message"), "session is missing the user message.");
assert(
  second.session.events.filter((event) => event.type === "agent-run-finished").length === 2,
  "session did not keep both finished runs."
);

console.log("MIGRATION_EXAMPLE_OK");
