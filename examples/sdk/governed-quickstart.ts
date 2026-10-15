/**
 * Credential-free governed path. CI imports `runGovernedQuickstart`.
 * Run it directly with `bun run examples/sdk/governed-quickstart.ts`.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  createEgressPolicy,
  createLatamSensitiveDataPolicy,
  EgressDeniedError,
  generateText,
  tool
} from "../../packages/sdk/src/index";
import type { LanguageModel, ModelGenerateInput } from "../../packages/sdk/src/index";

const CUIT = "20-12345678-6";
const CARD = "5300-1234-5678-9003";

const assistant = (text: string) => ({
  text,
  messages: [{ role: "assistant" as const, parts: [{ type: "text" as const, text }] }],
  finishReason: "stop" as const
});

export const runGovernedQuickstart = async (): Promise<void> => {
  const seen: ModelGenerateInput[] = [];
  const redaction = createLatamSensitiveDataPolicy();
  const egressPolicy = createEgressPolicy({
    allow: [{ provider: "mock", model: "mock-model", region: "*", endpoint: "*" }]
  });
  let calls = 0;
  const model: LanguageModel = {
    provider: "mock",
    modelId: "mock-model",
    capabilities: {
      streaming: false,
      tools: true,
      structuredOutput: false,
      jsonMode: false,
      toolChoice: false,
      parallelToolCalls: false,
      vision: false,
      files: false,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
      reasoning: false,
      webSearch: false
    },
    async generate(input) {
      seen.push(input);
      calls += 1;
      if (calls === 1) {
        return {
          messages: [{
            role: "assistant",
            parts: [{
              type: "tool-call",
              toolCall: { id: "call-1", name: "lookup", input: { account: CUIT } }
            }]
          }],
          finishReason: "tool-calls"
        };
      }
      return assistant("done");
    }
  };

  const result = await generateText({
    model,
    prompt: `Customer ${CUIT}`,
    maxSteps: 2,
    redaction,
    egressPolicy,
    tools: {
      lookup: tool({
        name: "lookup",
        description: "Look up an account reference",
        schema: z.object({ account: z.string() }),
        execute: async () => ({ card: CARD })
      })
    }
  });

  assert.equal(seen.length, 2);
  assert.equal(JSON.stringify(seen[0]?.messages).includes(CUIT), false);
  assert.equal(JSON.stringify(seen[0]?.messages).includes("[REDACTED:CUIT]"), true);
  assert.equal(JSON.stringify(seen[1]?.messages).includes(CARD), false);
  assert.equal(JSON.stringify(seen[1]?.messages).includes("[REDACTED:CARD]"), true);
  assert.equal(egressPolicy.records.length, 2);
  assert.equal(egressPolicy.records.every((record) => record.decision === "allowed"), true);
  assert.equal(result.text, "done");

  const denied = createEgressPolicy({ allow: [] });
  let deniedCalls = 0;
  await assert.rejects(
    generateText({
      model: {
        ...model,
        async generate(input) {
          deniedCalls += 1;
          return model.generate(input);
        }
      },
      prompt: "hello",
      egressPolicy: denied
    }),
    (error: unknown) => error instanceof EgressDeniedError
  );
  assert.equal(deniedCalls, 0);
  assert.equal(denied.records.length, 1);
  assert.equal(denied.records[0]?.decision, "denied");
  console.log("GOVERNED_QUICKSTART_OK");
};

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await runGovernedQuickstart();
}
