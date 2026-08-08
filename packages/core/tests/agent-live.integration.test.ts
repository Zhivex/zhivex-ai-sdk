import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConflictError,
  createAgent,
  createPostgresAgentMemoryStore,
  createPostgresAgentRunStore,
  createTextMessage,
  resumeAgent,
  runAgent,
  streamAgent,
  tool,
  type AgentRunStore,
  type AgentToolCallJournalEntry,
  type LanguageModel,
  type ReasoningConfig,
  type StreamEvent
} from "../src/index.js";
import {
  integrationLanguageProviders,
  type IntegrationLanguageProvider
} from "./integration-registry.js";
import {
  createPostgresIntegrationClient,
  dropIntegrationTables,
  integrationTableName,
  type PostgresIntegrationClient
} from "./postgres-integration-client.js";

const certificationEnabled = process.env.ZHIVEX_AGENT_LIVE_CERTIFICATION === "1";
const postgresUrl = process.env.ZHIVEX_POSTGRES_INTEGRATION_URL;
const requestedProviderNames = [
  ...new Set(
    (process.env.ZHIVEX_AGENT_LIVE_PROVIDERS ?? "gemini,deepseek,qwen")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  )
];
const integrationProvidersByName = new Map(
  integrationLanguageProviders.map((provider) => [provider.name, provider])
);
const missingProviderNames = requestedProviderNames.filter(
  (name) => !integrationProvidersByName.has(name)
);

if (certificationEnabled && !postgresUrl) {
  throw new Error(
    "ZHIVEX_POSTGRES_INTEGRATION_URL is required when ZHIVEX_AGENT_LIVE_CERTIFICATION=1."
  );
}
if (certificationEnabled && missingProviderNames.length) {
  throw new Error(
    `Agent live certification is missing configured providers: ${missingProviderNames.join(", ")}.`
  );
}

const certifiedProviders = requestedProviderNames.flatMap((name) => {
  const provider = integrationProvidersByName.get(name);
  return provider ? [provider] : [];
});
const describeCertification = certificationEnabled
  ? (describe.sequential ?? describe.skip)
  : describe.skip;

const runTable = integrationTableName("ar");
const runTables = [
  `${runTable}_memory`,
  `${runTable}_tool_journal`,
  `${runTable}_leases`,
  `${runTable}_parents`,
  `${runTable}_idempotency`,
  runTable
];

const providerReasoning = (providerName: string): ReasoningConfig | undefined =>
  providerName === "deepseek" || providerName === "qwen"
    ? { effort: "none" }
    : undefined;

const providerOptions = (providerName: string): Record<string, unknown> | undefined =>
  providerName === "deepseek" ? { strictTools: true } : undefined;

const createApprovalAgent = (
  provider: IntegrationLanguageProvider,
  store: AgentRunStore,
  onToolExecution: () => void
) => {
  const completionToken = `agent-${provider.name}-approval-ok`;
  return {
    completionToken,
    agent: createAgent({
      id: `live-${provider.name}-approval-agent`,
      model: provider.createModel(),
      instructions:
        `Call certify_add when requested. After its result has total 5, reply exactly: ${completionToken}`,
      maxSteps: 3,
      maxTokens: provider.toolMaxTokens ?? 256,
      reasoning: providerReasoning(provider.name),
      providerOptions: providerOptions(provider.name),
      store,
      tools: {
        certify_add: tool({
          name: "certify_add",
          description: "Adds the fixed certification integers 2 and 3.",
          schema: z.object({
            a: z.number().int(),
            b: z.number().int()
          }).strict(),
          requiresApproval: true,
          approvalMode: "interrupt",
          approvalVersion: "live-certification-v1",
          execute: ({ a, b }) => {
            onToolExecution();
            return { total: a + b, certifiedProvider: provider.name };
          }
        })
      }
    })
  };
};

const createDeterministicModel = (
  generate: LanguageModel["generate"]
): LanguageModel => ({
  provider: "postgres-certification",
  modelId: "agent-store-certification",
  capabilities: {
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
  },
  generate,
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "postgres-agent-ok" };
      yield { type: "finish", finishReason: "stop" };
    })();
  }
});

describeCertification("live agent providers with real Postgres durability", () => {
  let cleanupClient: PostgresIntegrationClient;

  beforeAll(async () => {
    cleanupClient = createPostgresIntegrationClient(postgresUrl!);
    const ping = await cleanupClient.query<{ value: number }>("SELECT 1 AS value");
    expect(Number(ping.rows[0]?.value)).toBe(1);
  });

  afterAll(async () => {
    if (!cleanupClient) return;
    await dropIntegrationTables(cleanupClient, runTables);
    await cleanupClient.close();
  });

  for (const provider of certifiedProviders) {
    it(`${provider.name} suspends a real tool call, restarts, resumes, and journals it once`, async () => {
      const scope = {
        tenantId: "agent-live-certification",
        userId: provider.name,
        namespace: "approval-resume"
      };
      const idempotencyKey = `live-${provider.name}-${Date.now()}`;
      let toolExecutions = 0;
      let runId = "";
      let approvalRequestId = "";
      let approvalProvider = "";

      const firstClient = createPostgresIntegrationClient(postgresUrl!);
      try {
        const store = createPostgresAgentRunStore({ client: firstClient, tableName: runTable });
        const { agent } = createApprovalAgent(provider, store, () => {
          toolExecutions += 1;
        });
        const waiting = await runAgent(agent, {
          prompt:
            "Call certify_add exactly once now with a=2 and b=3. Do not ask questions or request confirmation.",
          scope,
          idempotencyKey,
          toolChoice: provider.toolChoiceForTool?.("certify_add")
        });

        expect(waiting.status, waiting.outputText).toBe("waiting_approval");
        expect(waiting.state.pendingApprovals).toHaveLength(1);
        expect(waiting.state.pendingApprovals[0]).toMatchObject({
          kind: "local-tool",
          name: "certify_add"
        });
        expect(toolExecutions).toBe(0);
        runId = waiting.state.runId;
        approvalRequestId = waiting.state.pendingApprovals[0]!.id;
        approvalProvider = waiting.state.pendingApprovals[0]!.provider;
      } finally {
        await firstClient.close();
      }

      const secondClient = createPostgresIntegrationClient(postgresUrl!);
      try {
        const store = createPostgresAgentRunStore({ client: secondClient, tableName: runTable });
        const { agent, completionToken } = createApprovalAgent(provider, store, () => {
          toolExecutions += 1;
        });
        const persistedWaiting = await store.load(runId, scope);
        expect(persistedWaiting).toMatchObject({
          runId,
          status: "waiting_approval",
          idempotencyKey
        });

        const resumed = await resumeAgent(agent, {
          state: persistedWaiting!,
          approvals: [
            {
              provider: approvalProvider,
              approvalRequestId,
              approve: true,
              reason: "live certification approval"
            }
          ]
        });

        expect(resumed.status, resumed.outputText).toBe("completed");
        expect(resumed.outputText.toLowerCase()).toContain(completionToken);
        expect(resumed.toolResults).toContainEqual(
          expect.objectContaining({
            toolName: "certify_add",
            isError: false,
            output: { total: 5, certifiedProvider: provider.name }
          })
        );
        expect(resumed.state.pendingApprovals).toEqual([]);
        expect(resumed.state.approvalHistory).toHaveLength(1);
        expect(toolExecutions).toBe(1);

        const journal = await store.listToolCalls?.(runId, scope);
        expect(journal).toHaveLength(1);
        expect(journal?.[0]).toMatchObject({
          toolName: "certify_add",
          status: "completed",
          output: { total: 5, certifiedProvider: provider.name }
        });
        await expect(store.load(runId, scope)).resolves.toMatchObject({
          status: "completed",
          outputText: expect.stringContaining(completionToken)
        });
      } finally {
        await secondClient.close();
      }
    });

    it(`${provider.name} streams a real agent run and persists the final state`, async () => {
      const client = createPostgresIntegrationClient(postgresUrl!);
      try {
        const store = createPostgresAgentRunStore({ client, tableName: runTable });
        const completionToken = `agent-${provider.name}-stream-ok`;
        const agent = createAgent({
          id: `live-${provider.name}-stream-agent`,
          model: provider.createModel(),
          instructions: `Reply exactly with the requested certification token and nothing else.`,
          maxSteps: 1,
          maxTokens: provider.textMaxTokens ?? 128,
          reasoning: providerReasoning(provider.name),
          providerOptions: providerOptions(provider.name),
          store
        });
        const scope = {
          tenantId: "agent-live-certification",
          userId: provider.name,
          namespace: "stream"
        };
        const result = streamAgent(agent, {
          prompt: `Reply exactly: ${completionToken}`,
          scope,
          idempotencyKey: `stream-${provider.name}-${Date.now()}`
        });
        const textChunks: string[] = [];
        const eventTypes: string[] = [];

        await Promise.all([
          (async () => {
            for await (const chunk of result.textStream) textChunks.push(chunk);
          })(),
          (async () => {
            for await (const event of result.eventStream) eventTypes.push(event.type);
          })()
        ]);
        const final = await result.collect();

        expect(final.status, final.outputText).toBe("completed");
        expect(textChunks.join("").toLowerCase()).toContain(completionToken);
        expect(final.outputText.toLowerCase()).toContain(completionToken);
        expect(eventTypes).toEqual(
          expect.arrayContaining([
            "agent-run-start",
            "agent-step-start",
            "text-delta",
            "finish",
            "agent-step-finish",
            "agent-run-finish"
          ])
        );
        await expect(store.load(final.state.runId, scope)).resolves.toMatchObject({
          status: "completed",
          outputText: expect.stringContaining(completionToken)
        });
      } finally {
        await client.close();
      }
    });
  }

  it("enforces real Postgres claims, CAS, leases, and tool-journal ownership", async () => {
    const firstClient = createPostgresIntegrationClient(postgresUrl!);
    const secondClient = createPostgresIntegrationClient(postgresUrl!);
    try {
      const firstStore = createPostgresAgentRunStore({ client: firstClient, tableName: runTable });
      const secondStore = createPostgresAgentRunStore({ client: secondClient, tableName: runTable });
      const scope = {
        tenantId: "agent-live-certification",
        userId: "postgres",
        namespace: "concurrency"
      };
      const idempotencyKey = `postgres-agent-${Date.now()}`;
      let modelCalls = 0;
      const model = createDeterministicModel(async () => {
        modelCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          messages: [createTextMessage("assistant", "postgres-agent-ok")],
          text: "postgres-agent-ok",
          finishReason: "stop"
        };
      });
      const firstAgent = createAgent({ id: "postgres-live-agent", model, store: firstStore });
      const secondAgent = createAgent({ id: "postgres-live-agent", model, store: secondStore });

      const runs = await Promise.allSettled([
        runAgent(firstAgent, { prompt: "Execute once.", scope, idempotencyKey }),
        runAgent(secondAgent, { prompt: "Execute once.", scope, idempotencyKey })
      ]);
      const runErrors = runs.flatMap((result) =>
        result.status === "rejected"
          ? [result.reason instanceof Error ? `${result.reason.name}: ${result.reason.message}` : String(result.reason)]
          : []
      );
      expect(
        runs.filter((result) => result.status === "fulfilled"),
        runErrors.join("\n")
      ).toHaveLength(2);
      expect(modelCalls).toBe(1);
      const outputs = runs.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      );
      expect(new Set(outputs.map((output) => output.state.runId)).size).toBe(1);

      const state = await firstStore.findByIdempotencyKey?.(idempotencyKey, scope);
      expect(state).toMatchObject({ status: "completed", outputText: "postgres-agent-ok" });
      const runId = state!.runId;
      const revision = state!.revision!;

      const firstMemory = createPostgresAgentMemoryStore({
        client: firstClient,
        tableName: `${runTable}_memory`,
        scope
      });
      await firstMemory.save?.({
        runId,
        agentId: "postgres-live-agent",
        scope,
        state: state!
      });
      const secondMemory = createPostgresAgentMemoryStore({
        client: secondClient,
        tableName: `${runTable}_memory`,
        scope
      });
      await expect(
        secondMemory.load({ runId, agentId: "postgres-live-agent", scope })
      ).resolves.toEqual([
        expect.objectContaining({
          role: "assistant",
          parts: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "postgres-agent-ok" })
          ])
        })
      ]);

      const casResults = await Promise.allSettled([
        firstStore.save(
          { ...structuredClone(state!), outputText: "cas-first" },
          { expectedRevision: revision }
        ),
        secondStore.save(
          { ...structuredClone(state!), outputText: "cas-second" },
          { expectedRevision: revision }
        )
      ]);
      expect(casResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const casRejected = casResults.find((result) => result.status === "rejected");
      expect(casRejected).toMatchObject({ reason: expect.any(ConflictError) });

      await expect(
        firstStore.acquireLease?.(runId, { ownerId: "worker-a", ttlMs: 10, now: 100 }, scope)
      ).resolves.toMatchObject({ ownerId: "worker-a", expiresAt: 110 });
      await expect(
        secondStore.acquireLease?.(runId, { ownerId: "worker-b", ttlMs: 10, now: 105 }, scope)
      ).resolves.toBeUndefined();
      await expect(
        secondStore.acquireLease?.(runId, { ownerId: "worker-b", ttlMs: 10, now: 111 }, scope)
      ).resolves.toMatchObject({ ownerId: "worker-b", expiresAt: 121 });

      const journalEntry: AgentToolCallJournalEntry = {
        runId,
        scope,
        toolCallId: "postgres-live-tool-call",
        toolName: "certified_side_effect",
        status: "pending",
        idempotencyKey: `${idempotencyKey}:tool`,
        revision: 0,
        input: { value: 1 },
        updatedAt: Date.now()
      };
      const journalClaims = await Promise.all([
        firstStore.claimToolExecution!(journalEntry),
        secondStore.claimToolExecution!(journalEntry)
      ]);
      expect(journalClaims.map((claim) => claim.claimed).sort()).toEqual([false, true]);
      const completed = await firstStore.completeToolExecution!(
        {
          ...journalEntry,
          status: "completed",
          output: { sideEffectId: "effect-1" },
          completedAt: Date.now(),
          updatedAt: Date.now()
        },
        { expectedRevision: 0 }
      );
      expect(completed).toMatchObject({ status: "completed", revision: 1 });
      await expect(
        secondStore.loadToolExecution?.(runId, journalEntry.toolCallId, scope)
      ).resolves.toMatchObject({
        status: "completed",
        revision: 1,
        output: { sideEffectId: "effect-1" }
      });
    } finally {
      await Promise.all([firstClient.close(), secondClient.close()]);
    }
  });
});
