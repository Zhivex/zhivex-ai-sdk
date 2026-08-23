import assert from "node:assert/strict";

import {
  Agent,
  createFileSessionService,
  createRunner,
  generateText
} from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { createFetchChatTransport } from "@zhivex-ai/react";

const live = process.env.ZHIVEX_GOLDEN_PATH_LIVE === "1";
const startedAt = performance.now();
const capabilities = {
  streaming: false,
  tools: false,
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
};

const deterministicModel = {
  provider: "golden-path-smoke",
  modelId: "deterministic",
  capabilities,
  async generate(input) {
    const lastText = input.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .at(-1)?.text ?? "";
    const text = `reply:${lastText}`;
    return {
      text,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      messages: [{ role: "assistant", parts: [{ type: "text", text }] }]
    };
  }
};

const apiKey = process.env.OPENAI_API_KEY;
if (live && !apiKey) {
  throw new Error("ZHIVEX_GOLDEN_PATH_LIVE=1 requires OPENAI_API_KEY.");
}
const model = live
  ? createOpenAI({ apiKey })("gpt-4o-mini")
  : deterministicModel;

const first = await generateText({
  model,
  prompt: "Reply with exactly: connected",
  maxTokens: 64,
  timeoutMs: 30_000
});
assert.ok(first.text.length > 0);
const firstResponseMs = Math.round(performance.now() - startedAt);
assert.ok(firstResponseMs < 5 * 60_000, "first response exceeded five minutes");

const createPersistentRunner = () => createRunner({
  appName: "installed-golden-path",
  agent: new Agent({
    model,
    instructions: "Keep replies short.",
    maxSteps: 2,
    maxTokens: 64,
    policy: {
      timeoutMs: 60_000,
      onTimeout: "cancel-requested",
      budget: { maxSteps: 2, maxOutputTokens: 256, maxTotalTokens: 1_024 }
    }
  }),
  sessionService: createFileSessionService({ directory: ".zhivex/golden-path-sessions" })
});

const firstTurn = await createPersistentRunner().run({
  userId: "golden-path-user",
  sessionId: "golden-path-session",
  prompt: "Remember that my preferred format is concise."
});
assert.equal(firstTurn.output.status, "completed");

// Recreate both Runner and SessionService to prove that the second turn reads durable state.
const secondTurn = await createPersistentRunner().run({
  userId: "golden-path-user",
  sessionId: firstTurn.session.sessionId,
  prompt: "What format do I prefer?"
});
assert.equal(secondTurn.output.status, "completed");
assert.ok(secondTurn.session.events.filter((event) => event.type === "user-message").length >= 2);
assert.equal(typeof createFetchChatTransport, "function");

const persistentChatMs = Math.round(performance.now() - startedAt);
assert.ok(persistentChatMs < 15 * 60_000, "persistent chat exceeded fifteen minutes");

console.log(JSON.stringify({
  schemaVersion: 1,
  type: "golden_path_installed_smoke",
  status: "passed",
  mode: live ? "live" : "deterministic",
  runtime: { name: "bun", version: Bun.version },
  firstResponseMs,
  persistentChatMs,
  installedEntrypoints: [
    "@zhivex-ai/sdk",
    "@zhivex-ai/openai",
    "@zhivex-ai/react"
  ]
}));
