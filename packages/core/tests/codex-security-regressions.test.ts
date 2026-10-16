import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  ConflictError,
  ValidationError,
  createAgent,
  createFileAgentRunStore,
  createFileSessionService,
  createInMemoryAgentRunStore,
  createInMemorySessionService,
  createInMemoryWorkflowStateService,
  createPostgresAgentRunStore,
  createRunner,
  createSqliteAgentRunStore,
  createSqliteSessionService,
  createSqliteWorkflowStateService,
  createTextMessage,
  createWorkflow,
  loadWorkflowState,
  runWorkflow,
  streamText,
  generateText,
  toUIMessageStream,
  tool,
  type AgentRunState,
  type AgentStep,
  type LanguageModel,
  type PostgresClientLike,
  type SessionService,
  type SqliteDatabaseLike,
  type StreamEvent,
  type WorkflowStateService
} from "../src/index.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const capabilities: LanguageModel["capabilities"] = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: true,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false
};

const createLanguageModel = (overrides?: Partial<LanguageModel>): LanguageModel => ({
  provider: "test",
  modelId: "security-model",
  capabilities,
  async generate() {
    return {
      messages: [createTextMessage("assistant", "ok")],
      text: "ok",
      finishReason: "stop"
    };
  },
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "finish", finishReason: "stop" };
    })();
  },
  ...overrides
});

const sqlite = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  cleanup.push(() => db.close());
  return db;
};

const adapter = (db: DatabaseSync): SqliteDatabaseLike => ({
  exec: (sql) => db.exec(sql),
  prepare: (sql: string) => {
    const statement = db.prepare(sql);
    return {
      run: (parameters: readonly unknown[] = []) => statement.run(...parameters),
      get: (parameters: readonly unknown[] = []) => statement.get(...parameters) as Record<string, unknown> | undefined,
      all: (parameters: readonly unknown[] = []) => statement.all(...parameters) as Record<string, unknown>[]
    };
  }
});

const directory = async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-security-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const runState = (runId: string, extra: Partial<AgentRunState> = {}): AgentRunState => ({
  schemaVersion: 1,
  runId,
  provider: "fixture",
  modelId: "fixture",
  status: "completed",
  messages: [],
  steps: [],
  toolResults: [],
  pendingApprovals: [],
  currentStep: 0,
  maxSteps: 8,
  outputText: "",
  updatedAt: 1,
  ...extra
});

const duplicateToolCalls = () => ({
  messages: [
    {
      role: "assistant" as const,
      parts: [
        { type: "tool-call" as const, toolCall: { id: "same", name: "delete_file", input: { path: "secret" } } },
        { type: "tool-call" as const, toolCall: { id: "same", name: "read_file", input: { path: "secret" } } }
      ]
    }
  ],
  finishReason: "tool-calls" as const
});

const sensitiveTools = (executions: { count: number }) => ({
  delete_file: tool({
    name: "delete_file",
    schema: z.object({ path: z.string() }),
    requiresApproval: true,
    execute: () => {
      executions.count += 1;
      return "deleted";
    }
  }),
  read_file: tool({
    name: "read_file",
    schema: z.object({ path: z.string() }),
    execute: () => {
      executions.count += 1;
      return "read";
    }
  })
});

const gateFirstArrivals = () => {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async arrive(armed: boolean) {
      if (!armed || arrived >= 2) return;
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    }
  };
};

describe("duplicate tool-call ids", () => {
  it("rejects a model batch before approval policy or execution", async () => {
    const executions = { count: 0 };
    let policyCalls = 0;
    const attempt = generateText({
      model: createLanguageModel({
        async generate() {
          return duplicateToolCalls();
        }
      }),
      prompt: "Act on the file",
      maxSteps: 2,
      toolApprovalPolicy() {
        policyCalls += 1;
        return policyCalls === 1 ? false : true;
      },
      tools: sensitiveTools(executions)
    });

    await expect(attempt).rejects.toThrow(new ValidationError('Duplicate tool-call ID "same" is not allowed.'));
    expect(policyCalls).toBe(0);
    expect(executions.count).toBe(0);
  });

  it("rejects unresolved duplicate ids in the message history before execution", async () => {
    const executions = { count: 0 };
    let generated = false;
    const attempt = generateText({
      model: createLanguageModel({
        async generate() {
          generated = true;
          return { messages: [createTextMessage("assistant", "unused")], text: "unused", finishReason: "stop" };
        }
      }),
      maxSteps: 2,
      messages: [
        createTextMessage("user", "Continue"),
        ...duplicateToolCalls().messages
      ],
      tools: sensitiveTools(executions)
    });

    await expect(attempt).rejects.toThrow('Duplicate tool-call ID "same" is not allowed.');
    expect(generated).toBe(false);
    expect(executions.count).toBe(0);
  });

  it("rejects streamed duplicate ids before either call executes", async () => {
    const executions = { count: 0 };
    const result = streamText({
      model: createLanguageModel({
        async stream() {
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "tool-call", toolCall: { id: "same", name: "delete_file", input: { path: "secret" } } };
            yield { type: "tool-call", toolCall: { id: "same", name: "read_file", input: { path: "secret" } } };
            yield { type: "finish", finishReason: "tool-calls" };
          })();
        }
      }),
      prompt: "Act on the file",
      maxSteps: 2,
      toolApprovalPolicy: () => true,
      tools: sensitiveTools(executions)
    });

    await expect(result.collect()).rejects.toThrow('Duplicate tool-call ID "same" is not allowed.');
    expect(executions.count).toBe(0);
  });
});

describe("ui agent stream redaction", () => {
  it("sends a step summary and omits terminal run state unless opted in", async () => {
    const secret = "system-prompt-must-stay-server-side";
    const toolOutput = "tool-output-must-stay-server-side";
    const step: AgentStep = {
      index: 2,
      status: "failed",
      startedAt: 10,
      finishedAt: 20,
      request: {
        messages: [createTextMessage("system", secret)],
        providerOptions: { openai: { apiKey: "provider-option-secret" } }
      },
      response: {
        messages: [createTextMessage("assistant", "private response")],
        text: "private response",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 }
      },
      toolResults: [{ toolCallId: "call-1", toolName: "read_file", isError: false, output: toolOutput }],
      error: { message: "public failure", diagnosticCode: "internal-code" }
    };
    const state = {
      schemaVersion: 1,
      runId: "run-secret",
      provider: "test",
      modelId: "secret-model",
      status: "failed",
      messages: [createTextMessage("system", secret)],
      steps: [step],
      toolResults: step.toolResults,
      pendingApprovals: [],
      currentStep: 1,
      maxSteps: 4,
      outputText: toolOutput,
      updatedAt: 20
    } as AgentRunState;
    const events = (async function* () {
      yield { type: "agent-step-finish" as const, step };
      yield { type: "agent-run-finish" as const, status: "failed" as const, state };
    })();

    const chunks = await Array.fromAsync(toUIMessageStream(events, { messageId: "assistant-1" }));
    expect(chunks).toEqual([
      {
        type: "agent-step-finish",
        step: {
          index: 2,
          status: "failed",
          startedAt: 10,
          finishedAt: 20,
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
          error: { message: "public failure" }
        }
      }
    ]);
    const encoded = JSON.stringify(chunks);
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain(toolOutput);
    expect(encoded).not.toContain("provider-option-secret");
    expect(encoded).not.toContain("internal-code");
    expect(encoded).not.toContain("private response");

    const explicit = await Array.fromAsync(toUIMessageStream(
      (async function* () {
        yield { type: "agent-run-finish" as const, status: "failed" as const, state };
      })(),
      { messageId: "assistant-1", includeAgentRunFinish: true }
    ));
    expect(explicit).toEqual([{ type: "agent-run-finish", status: "failed", state }]);
  });
});

describe("workflow caller identity", () => {
  it("rejects mismatched user, session, and workflow ids before the runner", async () => {
    const seen: Array<{ userId: string; sessionId?: string }> = [];
    const inner = createRunner({
      appName: "identity",
      agent: createAgent({ model: createLanguageModel(), maxSteps: 2 }),
      sessionService: createInMemorySessionService()
    });
    const runner = {
      run: async (input: Parameters<typeof inner.run>[0]) => {
        seen.push({ userId: input.userId, sessionId: input.sessionId });
        return inner.run(input);
      }
    };
    const workflow = createWorkflow({
      id: "identity-workflow",
      steps: [{ id: "task", runner, prompt: "Hello", outputKey: "result" }]
    });

    const completed = await runWorkflow(workflow, { userId: "user_1", sessionId: "session_1" });
    expect(seen).toEqual([{ userId: "user_1", sessionId: "session_1" }]);

    await expect(runWorkflow(workflow, {
      userId: "attacker",
      sessionId: "session_1",
      state: completed.state
    })).rejects.toThrow("Workflow state userId does not match the authenticated user.");
    await expect(runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "attacker-session",
      state: completed.state
    })).rejects.toThrow("Workflow state sessionId does not match the authenticated session.");
    await expect(runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1",
      state: { ...completed.state, workflowId: "other-workflow" }
    })).rejects.toThrow("Workflow state workflowId does not match the workflow definition.");
    expect(seen).toHaveLength(1);

    const resumed = await runWorkflow(workflow, { userId: "user_1", state: completed.state });
    expect(resumed.state.sessionId).toBe("session_1");
    expect(seen.at(-1)).toEqual({ userId: "user_1", sessionId: "session_1" });
  });
});

describe("workflow execution claim", () => {
  const workflowFor = (
    service: WorkflowStateService,
    sessionService: SessionService,
    generate: LanguageModel["generate"]
  ) => createWorkflow({
    id: "claimed-review",
    persistence: { appName: "workflow-test", sessionService, workflowStateService: service },
    steps: [{
      id: "task",
      runner: createRunner({
        appName: "workflow-test",
        agent: createAgent({ model: createLanguageModel({ generate }), maxSteps: 2 }),
        sessionService
      }),
      prompt: "Review",
      outputKey: "result"
    }]
  });

  const gateService = (service: WorkflowStateService, armed: () => boolean): WorkflowStateService => {
    const barrier = gateFirstArrivals();
    return {
      ...service,
      async loadWorkflowState(input) {
        const record = await service.loadWorkflowState(input);
        await barrier.arrive(armed());
        return record;
      }
    };
  };

  it("lets one in-flight claim exclude a second resume until the step finishes", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executions = 0;
    const sessionService = createInMemorySessionService();
    const workflowStateService = createInMemoryWorkflowStateService();
    const workflow = workflowFor(workflowStateService, sessionService, async () => {
      executions += 1;
      if (executions === 1) await hold;
      return { messages: [createTextMessage("assistant", "reviewed")], text: "reviewed", finishReason: "stop" };
    });
    const input = { userId: "user_1", sessionId: "session_1" };
    const first = runWorkflow(workflow, input);
    await viWaitUntil(() => executions === 1);
    await expect(runWorkflow(workflow, input)).rejects.toThrow(
      new ConflictError("Workflow execution is already claimed.")
    );
    release();
    await expect(first).resolves.toMatchObject({ status: "completed", outputs: { result: "reviewed" } });
    expect(executions).toBe(1);
    const persisted = await loadWorkflowState(workflow, input);
    expect(persisted?.executionClaim).toBeUndefined();
    expect(persisted?.outputs).toEqual({ result: "reviewed" });

    const record = await workflowStateService.loadWorkflowState({
      appName: "workflow-test",
      ...input,
      workflowKey: "claimed-review"
    });
    await expect((async () => workflowStateService.saveWorkflowState({
      appName: "workflow-test",
      ...input,
      workflowKey: "claimed-review",
      state: { ...record!.state, outputs: { result: "stolen" } },
      expectedRevision: 0
    }))()).rejects.toThrow("WorkflowStateRecord revision conflict.");
    expect((await loadWorkflowState(workflow, input))?.outputs).toEqual({ result: "reviewed" });
  });

  it.each(["memory", "sqlite"] as const)("compare-and-swaps a concurrent %s claim before the step", async (kind) => {
    const sessionService = createInMemorySessionService();
    const inner = kind === "memory"
      ? createInMemoryWorkflowStateService()
      : createSqliteWorkflowStateService({ db: adapter(sqlite()) });
    let armed = false;
    const workflowStateService = gateService(inner, () => armed);
    let executions = 0;
    const workflow = workflowFor(workflowStateService, sessionService, async () => {
      executions += 1;
      return { messages: [createTextMessage("assistant", "once")], text: "once", finishReason: "stop" };
    });
    const input = { userId: "user_1", sessionId: `session-${kind}` };
    armed = true;
    const settled = await Promise.allSettled([runWorkflow(workflow, input), runWorkflow(workflow, input)]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === "rejected" && rejected[0].reason).toBeInstanceOf(ConflictError);
    expect(rejected[0]?.status === "rejected" && rejected[0].reason).toMatchObject({
      message: "WorkflowStateRecord revision conflict."
    });
    expect(executions).toBe(1);
    expect((await loadWorkflowState(workflow, input))?.outputs).toEqual({ result: "once" });
  });

  it("ignores a caller-supplied execution claim and still runs the step", async () => {
    let executions = 0;
    const sessionService = createInMemorySessionService();
    const workflow = workflowFor(createInMemoryWorkflowStateService(), sessionService, async () => {
      executions += 1;
      return { messages: [createTextMessage("assistant", "ran")], text: "ran", finishReason: "stop" };
    });
    const seeded = await runWorkflow(workflow, { userId: "user_1", sessionId: "session_1" });
    executions = 0;
    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1",
      state: {
        ...seeded.state,
        currentStepIndex: 0,
        status: "running",
        steps: [],
        outputs: {},
        executionClaim: { ownerId: "attacker", expiresAt: Date.now() + 60_000 }
      }
    });
    expect(result.status).toBe("completed");
    expect(executions).toBe(1);
    expect(result.state.executionClaim).toBeUndefined();
  });
});

describe("runner approval resume", () => {
  const approvalRunner = (sessionService: SessionService) => {
    let modelCalls = 0;
    const executions = { count: 0 };
    const agent = createAgent({
      model: createLanguageModel({
        async generate() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              messages: [{
                role: "assistant",
                parts: [{ type: "tool-call", toolCall: { id: "pay-1", name: "pay", input: { amount: 10 } } }]
              }],
              finishReason: "tool-calls"
            };
          }
          return { messages: [createTextMessage("assistant", "paid")], text: "paid", finishReason: "stop" };
        }
      }),
      maxSteps: 3,
      tools: {
        pay: tool({
          name: "pay",
          schema: z.object({ amount: z.number() }),
          requiresApproval: true,
          approvalMode: "interrupt",
          execute: () => {
            executions.count += 1;
            return "paid";
          }
        })
      }
    });
    return { runner: createRunner({ appName: "approvals", agent, sessionService }), executions };
  };

  const raceResumes = async (sessionService: SessionService) => {
    const barrier = gateFirstArrivals();
    let armed = false;
    const gated: SessionService = {
      ...sessionService,
      async loadSession(input) {
        const session = await sessionService.loadSession(input);
        await barrier.arrive(armed);
        return session;
      }
    };
    const { runner, executions } = approvalRunner(gated);
    const waiting = await runner.run({ userId: "user_1", sessionId: "session_1", prompt: "Pay the invoice" });
    expect(waiting.output.status).toBe("waiting_approval");
    expect(executions.count).toBe(0);
    const approvals = waiting.output.state.pendingApprovals.map((approval) => ({
      provider: approval.provider,
      approvalRequestId: approval.id,
      approve: true
    }));
    armed = true;
    const settled = await Promise.allSettled([
      runner.run({ userId: "user_1", sessionId: "session_1", approvals }),
      runner.run({ userId: "user_1", sessionId: "session_1", approvals })
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === "rejected" && rejected[0].reason).toBeInstanceOf(ConflictError);
    expect(rejected[0]?.status === "rejected" && String((rejected[0] as PromiseRejectedResult).reason)).toContain(
      "AgentSession revision conflict."
    );
    expect(executions.count).toBe(1);
    expect(fulfilled[0]?.status === "fulfilled" && fulfilled[0].value.output.status).toBe("completed");
  };

  it("compare-and-swaps concurrent in-memory approval resumes", async () => {
    await raceResumes(createInMemorySessionService());
  });

  it("compare-and-swaps concurrent sqlite approval resumes", async () => {
    await raceResumes(createSqliteSessionService({ db: adapter(sqlite()) }));
  });

  it("compare-and-swaps concurrent file approval resumes", async () => {
    await raceResumes(createFileSessionService({ directory: await directory() }));
  });
});

describe("idempotent run identity", () => {
  const claimCollision = async (store: {
    save: (state: AgentRunState) => unknown;
    load: (runId: string) => Promise<AgentRunState | undefined> | AgentRunState | undefined;
    claimIdempotencyKey?: (state: AgentRunState) => unknown;
    findByIdempotencyKey?: (key: string) => Promise<AgentRunState | undefined> | AgentRunState | undefined;
  }) => {
    await store.save(runState("run-a", { outputText: "original", idempotencyKey: "original-key" }));
    await expect((async () => store.claimIdempotencyKey!(
      runState("run-a", { outputText: "overwrite", idempotencyKey: "new-key" })
    ))()).rejects.toThrow(new ConflictError("Agent run identity already exists."));
    expect((await store.load("run-a"))?.outputText).toBe("original");
    expect((await store.load("run-a"))?.idempotencyKey).toBe("original-key");
    expect(await store.findByIdempotencyKey!("new-key")).toBeUndefined();
  };

  it("does not let a memory claim replace an existing run id", async () => {
    await claimCollision(createInMemoryAgentRunStore());
  });

  it("does not let a sqlite claim replace an existing run id", async () => {
    await claimCollision(createSqliteAgentRunStore({ db: adapter(sqlite()) }));
  });

  it("does not let a file claim replace an existing run id", async () => {
    await claimCollision(createFileAgentRunStore({ directory: await directory() }));
  });

  it("does not let a postgres insert-only claim replace an existing run id", async () => {
    const runs = new Map<string, AgentRunState>();
    const keys = new Map<string, string>();
    const client: PostgresClientLike = {
      async query(sql, params = []) {
        const statement = sql.trim();
        if (statement.startsWith("CREATE") || statement.startsWith("DELETE")) return { rows: [] };
        if (sql.includes("SELECT state_json FROM")) {
          const state = runs.get(String(params[0]));
          return { rows: state ? [{ state_json: state }] : [] };
        }
        if (sql.includes("INNER JOIN")) {
          const runId = keys.get(String(params[0]));
          const state = runId ? runs.get(runId) : undefined;
          return { rows: state ? [{ state_json: state }] : [] };
        }
        if (sql.includes("SELECT run_id FROM")) {
          const runId = keys.get(String(params[0]));
          return { rows: runId ? [{ run_id: runId }] : [] };
        }
        if (sql.includes("ON CONFLICT(run_id) DO NOTHING")) {
          const runId = String(params[0]);
          if (runs.has(runId)) return { rows: [] };
          runs.set(runId, params[1] as AgentRunState);
          return { rows: [{ run_id: runId }] };
        }
        if (sql.includes("ON CONFLICT(run_id) DO UPDATE") && sql.includes("state_json")) {
          runs.set(String(params[0]), params[1] as AgentRunState);
          return { rows: [{ run_id: params[0] }] };
        }
        if (sql.includes("parent_run_id")) return { rows: [] };
        if (sql.includes("ON CONFLICT(idempotency_key) DO NOTHING")) {
          const key = String(params[0]);
          if (keys.has(key)) return { rows: [] };
          keys.set(key, String(params[1]));
          return { rows: [{ run_id: params[1] }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }
    };
    await claimCollision(createPostgresAgentRunStore({ client }));
  });
});

const viWaitUntil = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the workflow claim to start.");
};
