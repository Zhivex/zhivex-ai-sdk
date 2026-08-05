import assert from "node:assert/strict";

import {
  AGENT_RUN_STATE_SCHEMA_VERSION,
  createAgent,
  resumeAgent,
  runAgent,
  tool
} from "@zhivex-ai/agents";
import { createPostgresAgentRunStore } from "@zhivex-ai/agents/ops";
import { createDeepSeek } from "@zhivex-ai/deepseek";
import { createGemini } from "@zhivex-ai/gemini";
import { createQwen } from "@zhivex-ai/qwen";
import postgres from "postgres";
import { z } from "zod";

const postgresUrl = process.env.ZHIVEX_POSTGRES_INTEGRATION_URL;
if (!postgresUrl) {
  throw new Error("ZHIVEX_POSTGRES_INTEGRATION_URL is required.");
}

const geminiApiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
const qwenApiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
const missingProviders = [
  ...(!geminiApiKey ? ["gemini"] : []),
  ...(!deepSeekApiKey ? ["deepseek"] : []),
  ...(!qwenApiKey ? ["qwen"] : [])
];
if (missingProviders.length) {
  throw new Error(`Installed agent live smoke is missing credentials for: ${missingProviders.join(", ")}.`);
}

const providers = [
  {
    name: "gemini",
    modelId: process.env.GEMINI_INTEGRATION_MODEL ?? "gemini-3.6-flash",
    createModel: () =>
      createGemini({
        apiKey: geminiApiKey,
        baseURL: process.env.GEMINI_BASE_URL
      })(process.env.GEMINI_INTEGRATION_MODEL ?? "gemini-3.6-flash"),
    maxTokens: 512,
    toolChoice: { type: "tool", toolName: "certify_add" }
  },
  {
    name: "deepseek",
    modelId: process.env.DEEPSEEK_INTEGRATION_MODEL ?? "deepseek-v4-flash",
    createModel: () =>
      createDeepSeek({
        apiKey: deepSeekApiKey,
        baseURL: process.env.DEEPSEEK_BASE_URL
      })(process.env.DEEPSEEK_INTEGRATION_MODEL ?? "deepseek-v4-flash"),
    maxTokens: 256,
    reasoning: { effort: "none" },
    providerOptions: { strictTools: true }
  },
  {
    name: "qwen",
    modelId: process.env.QWEN_INTEGRATION_MODEL ?? "qwen3.7-plus",
    createModel: () =>
      createQwen({
        apiKey: qwenApiKey,
        baseURL: process.env.QWEN_BASE_URL,
        workspaceId: process.env.QWEN_WORKSPACE_ID,
        region: process.env.QWEN_REGION
      })(process.env.QWEN_INTEGRATION_MODEL ?? "qwen3.7-plus"),
    maxTokens: 128,
    reasoning: { effort: "none" }
  }
];

const createPostgresClient = (url) => {
  const sql = postgres(url, { max: 4, onnotice: () => {} });
  return {
    async query(text, params = []) {
      const rows = await sql.unsafe(text, [...params]);
      return { rows };
    },
    async close() {
      await sql.end({ timeout: 1 });
    }
  };
};

const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const runTable = `zhivex_it_p_${suffix}`;
const runTables = [
  `${runTable}_tool_journal`,
  `${runTable}_leases`,
  `${runTable}_parents`,
  `${runTable}_idempotency`,
  runTable
];

const createApprovalAgent = (provider, store, onToolExecution) => {
  const completionToken = `installed-${provider.name}-approval-ok`;
  return {
    completionToken,
    agent: createAgent({
      id: `installed-${provider.name}-agent`,
      model: provider.createModel(),
      instructions:
        `Call certify_add when requested. After its result has total 5, reply exactly: ${completionToken}`,
      maxSteps: 3,
      maxTokens: provider.maxTokens,
      reasoning: provider.reasoning,
      providerOptions: provider.providerOptions,
      store,
      tools: {
        certify_add: tool({
          name: "certify_add",
          description: "Adds the certification integers.",
          schema: z.object({ a: z.number().int(), b: z.number().int() }).strict(),
          requiresApproval: true,
          approvalMode: "interrupt",
          approvalVersion: "installed-live-v1",
          execute: ({ a, b }) => {
            onToolExecution();
            return { total: a + b, provider: provider.name };
          }
        })
      }
    })
  };
};

assert.equal(AGENT_RUN_STATE_SCHEMA_VERSION, 1);
const cleanupClient = createPostgresClient(postgresUrl);
try {
  const ping = await cleanupClient.query("SELECT 1 AS value");
  assert.equal(Number(ping.rows[0]?.value), 1);

  for (const provider of providers) {
    const scope = {
      tenantId: "installed-agent-live",
      userId: provider.name,
      namespace: "approval-resume"
    };
    const idempotencyKey = `installed-${provider.name}-${Date.now()}`;
    let toolExecutions = 0;
    let waitingState;
    let approval;

    const firstClient = createPostgresClient(postgresUrl);
    try {
      const store = createPostgresAgentRunStore({ client: firstClient, tableName: runTable });
      const { agent } = createApprovalAgent(provider, store, () => {
        toolExecutions += 1;
      });
      const waiting = await runAgent(agent, {
        prompt: "Call certify_add exactly once now with a=2 and b=3. Do not request confirmation.",
        scope,
        idempotencyKey,
        ...(provider.toolChoice ? { toolChoice: provider.toolChoice } : {})
      });
      assert.equal(waiting.status, "waiting_approval", waiting.outputText);
      assert.equal(waiting.state.pendingApprovals.length, 1);
      assert.equal(toolExecutions, 0);
      waitingState = waiting.state;
      approval = waiting.state.pendingApprovals[0];
    } finally {
      await firstClient.close();
    }

    const secondClient = createPostgresClient(postgresUrl);
    try {
      const store = createPostgresAgentRunStore({ client: secondClient, tableName: runTable });
      const persisted = await store.load(waitingState.runId, scope);
      assert.equal(persisted?.status, "waiting_approval");
      const { agent, completionToken } = createApprovalAgent(provider, store, () => {
        toolExecutions += 1;
      });
      const resumed = await resumeAgent(agent, {
        state: persisted,
        approvals: [
          {
            provider: approval.provider,
            approvalRequestId: approval.id,
            approve: true,
            reason: "installed package certification"
          }
        ]
      });
      assert.equal(resumed.status, "completed", resumed.outputText);
      assert.ok(resumed.outputText.toLowerCase().includes(completionToken));
      assert.equal(toolExecutions, 1);
      assert.equal(resumed.toolResults.length, 1);
      assert.deepEqual(resumed.toolResults[0]?.output, { total: 5, provider: provider.name });
      const journal = await store.listToolCalls?.(persisted.runId, scope);
      assert.equal(journal?.length, 1);
      assert.equal(journal?.[0]?.status, "completed");
      assert.deepEqual(journal?.[0]?.output, { total: 5, provider: provider.name });
    } finally {
      await secondClient.close();
    }

    console.log(`Installed agent live smoke: ${provider.name}/${provider.modelId} PASS`);
  }
} finally {
  for (const tableName of runTables) {
    await cleanupClient.query(`DROP TABLE IF EXISTS ${tableName}`);
  }
  await cleanupClient.close();
}

console.log("INSTALLED_AGENT_LIVE_SMOKE_OK");
