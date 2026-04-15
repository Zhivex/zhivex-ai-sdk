import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  agentApprovalResponsePart,
  createAgent,
  createAgentHandoff,
  createAgentApprovalMessage,
  createFileAgentRunStore,
  createInMemoryAgentMemoryStore,
  createInMemoryAgentRunStore,
  createPostgresAgentMemoryStore,
  createPostgresAgentRunStore,
  createSqliteAgentMemoryStore,
  createSqliteAgentRunStore,
  createTextMessage,
  getAgentApprovalRequests,
  resumeAgent,
  runAgent,
  runAgentHandoff,
  streamAgent,
  toUIAgentStreamResponse,
  toUIMessageStream,
  tool,
  type AgentRunState,
  type PostgresClientLike,
  type LanguageModel,
  type ModelMessage,
  type SqliteDatabaseLike,
  type StreamEvent
} from "../src/index.js";

const createLanguageModel = (overrides?: Partial<LanguageModel>): LanguageModel => ({
  provider: "test",
  modelId: "agent-model",
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
  async generate() {
    return {
      messages: [createTextMessage("assistant", "hello world")],
      text: "hello world",
      finishReason: "stop"
    };
  },
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "hello" };
      yield { type: "text-delta", textDelta: " world" };
      yield { type: "finish", finishReason: "stop" };
    })();
  },
  ...overrides
});

class FakeSqliteDatabase implements SqliteDatabaseLike {
  private runTables = new Map<string, Map<string, string>>();
  private memoryTables = new Map<string, Map<string, string>>();

  exec(sql: string) {
    const match = sql.match(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (!match) {
      return;
    }

    const tableName = match[1]!;
    if (sql.includes("run_id")) {
      this.runTables.set(tableName, this.runTables.get(tableName) ?? new Map());
      return;
    }

    this.memoryTables.set(tableName, this.memoryTables.get(tableName) ?? new Map());
  }

  prepare<TResult extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
    return {
      run: (params?: readonly unknown[]) => {
        const values = [...(params ?? [])];
        const insertMatch = sql.match(/INSERT INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i);
        const deleteMatch = sql.match(/DELETE FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i);

        if (insertMatch) {
          const tableName = insertMatch[1]!;
          if (sql.includes("run_id")) {
            this.runTables.get(tableName)?.set(String(values[0]), String(values[1]));
            return;
          }

          this.memoryTables.get(tableName)?.set(String(values[0]), String(values[1]));
          return;
        }

        if (deleteMatch) {
          this.runTables.get(deleteMatch[1]!)?.delete(String(values[0]));
        }
      },
      get: (params?: readonly unknown[]) => {
        const values = [...(params ?? [])];
        const selectMatch = sql.match(/SELECT\s+.+\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
        if (!selectMatch) {
          return undefined;
        }

        const tableName = selectMatch[1]!;
        if (sql.includes("state_json")) {
          const stateJson = this.runTables.get(tableName)?.get(String(values[0]));
          return stateJson ? ({ state_json: stateJson } as TResult) : undefined;
        }

        const messagesJson = this.memoryTables.get(tableName)?.get(String(values[0]));
        return messagesJson ? ({ messages_json: messagesJson } as TResult) : undefined;
      }
    };
  }
}

class FakePostgresClient implements PostgresClientLike {
  private runTables = new Map<string, Map<string, AgentRunState>>();
  private memoryTables = new Map<string, Map<string, ModelMessage[]>>();

  async query<TResult extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    const createMatch = sql.match(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (createMatch) {
      const tableName = createMatch[1]!;
      if (sql.includes("run_id")) {
        this.runTables.set(tableName, this.runTables.get(tableName) ?? new Map());
      } else {
        this.memoryTables.set(tableName, this.memoryTables.get(tableName) ?? new Map());
      }
      return { rows: [] as TResult[] };
    }

    const insertMatch = sql.match(/INSERT INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (insertMatch) {
      const tableName = insertMatch[1]!;
      if (sql.includes("run_id")) {
        this.runTables.get(tableName)?.set(String(params[0]), JSON.parse(String(params[1])) as AgentRunState);
      } else {
        this.memoryTables.get(tableName)?.set(String(params[0]), JSON.parse(String(params[1])) as ModelMessage[]);
      }
      return { rows: [] as TResult[] };
    }

    const selectMatch = sql.match(/SELECT\s+.+\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (selectMatch) {
      const tableName = selectMatch[1]!;
      if (sql.includes("state_json")) {
        const state = this.runTables.get(tableName)?.get(String(params[0]));
        return { rows: state ? ([{ state_json: state }] as TResult[]) : [] };
      }

      const messages = this.memoryTables.get(tableName)?.get(String(params[0]));
      return { rows: messages ? ([{ messages_json: messages }] as TResult[]) : [] };
    }

    const deleteMatch = sql.match(/DELETE FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (deleteMatch) {
      this.runTables.get(deleteMatch[1]!)?.delete(String(params[0]));
    }

    return { rows: [] as TResult[] };
  }
}

describe("agent runtime", () => {
  it("runs a simple agent and returns serializable state", async () => {
    const agent = createAgent({
      id: "assistant-1",
      model: createLanguageModel(),
      instructions: "Be concise.",
      maxSteps: 2,
      metadata: {
        source: "test"
      }
    });

    const result = await runAgent(agent, {
      prompt: "Say hello"
    });

    expect(result.status).toBe("completed");
    expect(result.outputText).toBe("hello world");
    expect(result.state).toMatchObject({
      agentId: "assistant-1",
      provider: "test",
      modelId: "agent-model",
      currentStep: 1,
      maxSteps: 2,
      outputText: "hello world",
      metadata: {
        source: "test"
      }
    });
    expect(result.steps).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(result.state))).toEqual(result.state);
  });

  it("runs tool loops and records step snapshots", async () => {
    let callCount = 0;
    const model = createLanguageModel({
      async generate() {
        callCount += 1;

        if (callCount === 1) {
          return {
            messages: [
              {
                role: "assistant",
                parts: [
                  {
                    type: "tool-call",
                    toolCall: {
                      id: "tool-1",
                      name: "weather",
                      input: { city: "Madrid" }
                    }
                  }
                ]
              }
            ],
            finishReason: "tool-calls"
          };
        }

        return {
          messages: [createTextMessage("assistant", "Sunny in Madrid")],
          text: "Sunny in Madrid",
          finishReason: "stop"
        };
      }
    });

    const agent = createAgent({
      model,
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, temperatureC: 26 })
        })
      },
      maxSteps: 2
    });

    const result = await runAgent(agent, {
      prompt: "Weather in Madrid?"
    });

    expect(result.status).toBe("completed");
    expect(result.outputText).toBe("Sunny in Madrid");
    expect(result.toolResults).toEqual([
      {
        toolCallId: "tool-1",
        toolName: "weather",
        output: { city: "Madrid", temperatureC: 26 },
        isError: false
      }
    ]);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.request.messages[0]).toEqual(createTextMessage("user", "Weather in Madrid?"));
    expect(result.steps[1]?.response?.text).toBe("Sunny in Madrid");
  });

  it("can resume from previous state when maxSteps is extended", async () => {
    let callCount = 0;
    const agent = createAgent({
      model: createLanguageModel({
        async generate() {
          callCount += 1;

          if (callCount === 1) {
            return {
              messages: [
                {
                  role: "assistant",
                  parts: [
                    {
                      type: "tool-call",
                      toolCall: {
                        id: "tool-1",
                        name: "weather",
                        input: { city: "Madrid" }
                      }
                    }
                  ]
                }
              ],
              finishReason: "tool-calls"
            };
          }

          return {
            messages: [createTextMessage("assistant", "Sunny in Madrid")],
            text: "Sunny in Madrid",
            finishReason: "stop"
          };
        }
      }),
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, temperatureC: 26 })
        })
      },
      maxSteps: 1
    });

    const firstRun = await runAgent(agent, {
      prompt: "Weather in Madrid?"
    });

    expect(firstRun.status).toBe("failed");
    expect(firstRun.error?.message).toContain("maxSteps");
    expect(firstRun.state.currentStep).toBe(1);

    const resumed = await runAgent(agent, {
      state: firstRun.state,
      maxSteps: 2
    });

    expect(resumed.status).toBe("completed");
    expect(resumed.outputText).toBe("Sunny in Madrid");
    expect(resumed.state.currentStep).toBe(2);
    expect(resumed.steps).toHaveLength(2);
  });

  it("streams agent output and collects final state", async () => {
    const agent = createAgent({
      model: createLanguageModel({
        async generate() {
          throw new Error("unused");
        },
        async stream() {
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "text-delta", textDelta: "streamed" };
            yield { type: "text-delta", textDelta: " answer" };
            yield { type: "finish", finishReason: "stop" };
          })();
        }
      }),
      maxSteps: 2
    });

    const result = streamAgent(agent, {
      prompt: "Say hello"
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    const final = await result.collect();
    expect(chunks.join("")).toBe("streamed answer");
    expect(final.status).toBe("completed");
    expect(final.outputText).toBe("streamed answer");
    expect(final.state.currentStep).toBe(1);
  });

  it("fails fast when an input guardrail is triggered", async () => {
    let modelCalled = false;
    const agent = createAgent({
      id: "guarded-input",
      model: createLanguageModel({
        async generate() {
          modelCalled = true;
          return {
            messages: [createTextMessage("assistant", "should not run")],
            text: "should not run",
            finishReason: "stop"
          };
        }
      }),
      inputGuardrails: [
        async () => ({
          triggered: true,
          reason: "Blocked by input guardrail."
        })
      ]
    });

    const result = await runAgent(agent, {
      prompt: "Say hello"
    });

    expect(modelCalled).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe("Blocked by input guardrail.");
  });

  it("fails when an output guardrail is triggered", async () => {
    const agent = createAgent({
      id: "guarded-output",
      model: createLanguageModel(),
      outputGuardrails: [
        async ({ output }) =>
          output.outputText.includes("hello")
            ? {
                triggered: true,
                reason: "Blocked by output guardrail."
              }
            : undefined
      ]
    });

    const result = await runAgent(agent, {
      prompt: "Say hello"
    });

    expect(result.status).toBe("failed");
    expect(result.outputText).toBe("hello world");
    expect(result.error?.message).toBe("Blocked by output guardrail.");
  });

  it("suspends an agent when the model emits an approval request", async () => {
    const agent = createAgent({
      model: createLanguageModel({
        async generate() {
          return {
            messages: [
              {
                role: "assistant",
                parts: [
                  {
                    type: "provider-data",
                    provider: "openai",
                    data: {
                      type: "mcp_approval_request",
                      id: "mcpr_1",
                      arguments: "{\"path\":\"README.md\"}",
                      name: "fetch_docs",
                      server_label: "github"
                    }
                  },
                  {
                    type: "text",
                    text: "Need approval"
                  }
                ]
              }
            ],
            text: "Need approval",
            finishReason: "stop"
          };
        }
      }),
      maxSteps: 2
    });

    const result = await runAgent(agent, {
      prompt: "Use MCP"
    });

    expect(result.status).toBe("suspended");
    expect(result.state.pendingApprovals).toEqual([
      {
        provider: "openai",
        id: "mcpr_1",
        arguments: "{\"path\":\"README.md\"}",
        name: "fetch_docs",
        serverLabel: "github",
        rawData: {
          type: "mcp_approval_request",
          id: "mcpr_1",
          arguments: "{\"path\":\"README.md\"}",
          name: "fetch_docs",
          server_label: "github"
        }
      }
    ]);

    expect(getAgentApprovalRequests(result.messages)).toEqual(result.state.pendingApprovals);
  });

  it("resumes a suspended agent when approval responses are provided", async () => {
    let callCount = 0;
    let seenApprovalMessage = false;

    const agent = createAgent({
      model: createLanguageModel({
        async generate(input) {
          callCount += 1;

          if (callCount === 1) {
            return {
              messages: [
                {
                  role: "assistant",
                  parts: [
                    {
                      type: "provider-data",
                      provider: "openai",
                      data: {
                        type: "mcp_approval_request",
                        id: "mcpr_1",
                        arguments: "{}",
                        name: "fetch_docs",
                        server_label: "github"
                      }
                    }
                  ]
                }
              ],
              finishReason: "stop"
            };
          }

          const lastMessage = input.messages.at(-1);
          seenApprovalMessage =
            (lastMessage?.role === "user" &&
              lastMessage.parts.some(
                (part) =>
                  part.type === "provider-data" &&
                  part.provider === "openai" &&
                  (part.data as { type?: string }).type === "mcp_approval_response"
              )) ??
            false;

          return {
            messages: [createTextMessage("assistant", "Approved and completed")],
            text: "Approved and completed",
            finishReason: "stop"
          };
        }
      }),
      maxSteps: 3
    });

    const suspended = await runAgent(agent, {
      prompt: "Use MCP"
    });

    const resumed = await resumeAgent(agent, {
      state: suspended.state,
      approvals: [
        {
          provider: "openai",
          approvalRequestId: "mcpr_1",
          approve: true
        }
      ],
      maxSteps: 3
    });

    expect(seenApprovalMessage).toBe(true);
    expect(resumed.status).toBe("completed");
    expect(resumed.outputText).toBe("Approved and completed");
    expect(resumed.state.pendingApprovals).toEqual([]);
    expect(resumed.state.currentStep).toBe(2);
  });

  it("builds reusable approval response parts and messages", () => {
    expect(
      agentApprovalResponsePart({
        provider: "azure-openai",
        approvalRequestId: "mcpr_1",
        approve: false,
        reason: "Denied"
      })
    ).toEqual({
      type: "provider-data",
      provider: "azure-openai",
      data: {
        type: "mcp_approval_response",
        approval_request_id: "mcpr_1",
        approve: false,
        reason: "Denied"
      }
    });

    expect(
      createAgentApprovalMessage([
        {
          provider: "openai",
          approvalRequestId: "mcpr_1",
          approve: true
        }
      ])
    ).toEqual({
      role: "user",
      parts: [
        {
          type: "provider-data",
          provider: "openai",
          data: {
            type: "mcp_approval_response",
            approval_request_id: "mcpr_1",
            approve: true
          }
        }
      ]
    });
  });

  it("streams agent lifecycle and approval events", async () => {
    const agent = createAgent({
      model: createLanguageModel({
        async generate() {
          throw new Error("unused");
        },
        async stream() {
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield {
              type: "provider-data",
              provider: "openai",
              data: {
                type: "mcp_approval_request",
                id: "mcpr_1",
                arguments: "{}",
                name: "fetch_docs",
                server_label: "github"
              }
            };
            yield { type: "text-delta", textDelta: "Need approval" };
            yield { type: "finish", finishReason: "stop" };
          })();
        }
      }),
      maxSteps: 2
    });

    const stream = streamAgent(agent, {
      prompt: "Use MCP"
    });

    const events = [];
    for await (const event of stream.eventStream) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      type: "agent-run-start",
      currentStep: 1,
      maxSteps: 2
    });
    expect(events.some((event) => event.type === "agent-step-start")).toBe(true);
    expect(events.some((event) => event.type === "provider-data")).toBe(true);
    expect(events.some((event) => event.type === "agent-approval-request")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "agent-run-finish",
      status: "suspended"
    });
  });

  it("maps agent stream events into UI chunks and SSE", async () => {
    const agent = createAgent({
      model: createLanguageModel({
        async generate() {
          throw new Error("unused");
        },
        async stream() {
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield {
              type: "provider-data",
              provider: "openai",
              data: {
                type: "mcp_approval_request",
                id: "mcpr_1",
                arguments: "{}",
                name: "fetch_docs",
                server_label: "github"
              }
            };
            yield { type: "text-delta", textDelta: "Need approval" };
            yield { type: "finish", finishReason: "stop" };
          })();
        }
      }),
      maxSteps: 2
    });

    const stream = streamAgent(agent, {
      prompt: "Use MCP"
    });

    const chunks = [];
    for await (const chunk of toUIMessageStream(stream, "assistant-1")) {
      chunks.push(chunk);
    }

    expect(chunks.some((chunk) => chunk.type === "provider-data")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "agent-approval-request")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "agent-run-finish")).toBe(true);

    const response = toUIAgentStreamResponse(
      (async function* () {
        yield {
          type: "agent-run-start" as const,
          currentStep: 1,
          maxSteps: 2
        };
      })()
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("event: agent-run-start");
  });

  it("persists and reloads agent state through the run store", async () => {
    const store = createInMemoryAgentRunStore();
    const agent = createAgent({
      id: "persisted-agent",
      model: createLanguageModel(),
      store
    });

    const first = await runAgent(agent, {
      prompt: "Say hello"
    });

    const reloaded = await runAgent(agent, {
      runId: first.state.runId
    });

    expect(first.state.runId).toBeDefined();
    expect(reloaded.state.runId).toBe(first.state.runId);
    expect(store.load(first.state.runId)).toBeDefined();
    expect(reloaded.outputText).toBe("hello world");
  });

  it("writes serialized run state to the file-backed store", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-agent-store-"));
    const store = createFileAgentRunStore({ directory });
    const agent = createAgent({
      id: "file-agent",
      model: createLanguageModel(),
      store
    });

    const result = await runAgent(agent, {
      prompt: "Persist this"
    });

    const saved = JSON.parse(await readFile(path.join(directory, `${result.state.runId}.json`), "utf8")) as {
      runId: string;
      outputText: string;
    };
    expect(saved.runId).toBe(result.state.runId);
    expect(saved.outputText).toBe("hello world");
  });

  it("persists run state through the sqlite-backed store", async () => {
    const db = new FakeSqliteDatabase();
    const store = createSqliteAgentRunStore({
      db,
      tableName: "agent_runs"
    });
    const agent = createAgent({
      id: "sqlite-agent",
      model: createLanguageModel(),
      store
    });

    const first = await runAgent(agent, {
      prompt: "Persist in sqlite"
    });

    const reloaded = createSqliteAgentRunStore({
      db,
      tableName: "agent_runs"
    });
    const loaded = await Promise.resolve(reloaded.load(first.state.runId));

    expect(loaded?.runId).toBe(first.state.runId);
    expect(loaded?.outputText).toBe("hello world");

    await Promise.resolve(reloaded.delete?.(first.state.runId));
    await expect(Promise.resolve(reloaded.load(first.state.runId))).resolves.toBeUndefined();
  });

  it("persists run state through the postgres-backed store", async () => {
    const client = new FakePostgresClient();
    const store = createPostgresAgentRunStore({
      client,
      tableName: "agent_runs"
    });
    const agent = createAgent({
      id: "postgres-agent",
      model: createLanguageModel(),
      store
    });

    const first = await runAgent(agent, {
      prompt: "Persist in postgres"
    });

    const reloaded = createPostgresAgentRunStore({
      client,
      tableName: "agent_runs"
    });
    const loaded = await reloaded.load(first.state.runId);

    expect(loaded?.runId).toBe(first.state.runId);
    expect(loaded?.outputText).toBe("hello world");

    await reloaded.delete?.(first.state.runId);
    await expect(reloaded.load(first.state.runId)).resolves.toBeUndefined();
  });

  it("loads memory into fresh runs and saves the latest assistant context", async () => {
    const memory = createInMemoryAgentMemoryStore({
      initialMessages: {
        "memory-agent": [createTextMessage("assistant", "Remember that the user likes Madrid.")]
      }
    });

    let firstRequestMessages = [] as ReturnType<typeof createTextMessage>[];
    const agent = createAgent({
      id: "memory-agent",
      memory,
      model: createLanguageModel({
        async generate(input) {
          firstRequestMessages = input.messages as ReturnType<typeof createTextMessage>[];
          return {
            messages: [createTextMessage("assistant", "Memory updated")],
            text: "Memory updated",
            finishReason: "stop"
          };
        }
      })
    });

    await runAgent(agent, {
      prompt: "What city do I like?"
    });

    expect(firstRequestMessages.some((message) => message.parts.some((part) => part.type === "text" && part.text.includes("likes Madrid")))).toBe(true);

    const stored = await memory.load({
      runId: "ignored",
      agentId: "memory-agent"
    });
    expect(stored.at(-1)?.parts[0]).toMatchObject({
      type: "text",
      text: "Memory updated"
    });
  });

  it("emits tool approval telemetry when a local tool is denied", async () => {
    const events: string[] = [];
    let callCount = 0;
    const agent = createAgent({
      id: "tool-approval-agent",
      model: createLanguageModel({
        async generate() {
          callCount += 1;
          if (callCount === 1) {
            return {
              messages: [
                {
                  role: "assistant",
                  parts: [
                    {
                      type: "tool-call",
                      toolCall: {
                        id: "tool-1",
                        name: "weather",
                        input: { city: "Madrid" }
                      }
                    }
                  ]
                }
              ],
              finishReason: "tool-calls"
            };
          }

          return {
            messages: [createTextMessage("assistant", "Denied and continued")],
            text: "Denied and continued",
            finishReason: "stop"
          };
        }
      }),
      onTelemetryEvent(event) {
        events.push(event.type);
      },
      toolApprovalPolicy() {
        return {
          approved: false,
          reason: "Denied by policy."
        };
      },
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, temperatureC: 26 })
        })
      },
      maxSteps: 2
    });

    const result = await runAgent(agent, {
      prompt: "Weather in Madrid?"
    });

    expect(result.toolResults[0]).toMatchObject({
      toolName: "weather",
      isError: true
    });
    expect(events).toContain("tool-approval");
  });

  it("persists memory through the sqlite-backed store", async () => {
    const db = new FakeSqliteDatabase();
    const memory = createSqliteAgentMemoryStore({
      db,
      tableName: "agent_memory"
    });

    const agent = createAgent({
      id: "sqlite-memory-agent",
      memory,
      model: createLanguageModel({
        async generate() {
          return {
            messages: [createTextMessage("assistant", "SQLite memory updated")],
            text: "SQLite memory updated",
            finishReason: "stop"
          };
        }
      })
    });

    await runAgent(agent, {
      prompt: "Remember this in sqlite"
    });

    const reloaded = createSqliteAgentMemoryStore({
      db,
      tableName: "agent_memory"
    });
    const stored = await Promise.resolve(reloaded.load({
      runId: "ignored",
      agentId: "sqlite-memory-agent"
    }));

    expect(stored.at(-1)?.parts[0]).toMatchObject({
      type: "text",
      text: "SQLite memory updated"
    });
  });

  it("persists memory through the postgres-backed store", async () => {
    const client = new FakePostgresClient();
    const memory = createPostgresAgentMemoryStore({
      client,
      tableName: "agent_memory"
    });

    const agent = createAgent({
      id: "postgres-memory-agent",
      memory,
      model: createLanguageModel({
        async generate() {
          return {
            messages: [createTextMessage("assistant", "Postgres memory updated")],
            text: "Postgres memory updated",
            finishReason: "stop"
          };
        }
      })
    });

    await runAgent(agent, {
      prompt: "Remember this in postgres"
    });

    const reloaded = createPostgresAgentMemoryStore({
      client,
      tableName: "agent_memory"
    });
    const stored = await reloaded.load({
      runId: "ignored",
      agentId: "postgres-memory-agent"
    });

    expect(stored.at(-1)?.parts[0]).toMatchObject({
      type: "text",
      text: "Postgres memory updated"
    });
  });

  it("creates handoffs and runs downstream agents with transferred context", async () => {
    const source = await runAgent(
      createAgent({
        id: "planner",
        model: createLanguageModel({
          async generate() {
            return {
              messages: [createTextMessage("assistant", "Plan a museum visit in Madrid")],
              text: "Plan a museum visit in Madrid",
              finishReason: "stop"
            };
          }
        })
      }),
      {
        prompt: "Plan something"
      }
    );

    let seenHandoff = false;
    const specialist = createAgent({
      id: "booking",
      model: createLanguageModel({
        async generate(input) {
          seenHandoff = input.messages.some(
            (message) =>
              message.role === "user" &&
              message.parts.some((part) => part.type === "text" && part.text.includes("Handoff from planner"))
          );
          return {
            messages: [createTextMessage("assistant", "Booked the museum visit")],
            text: "Booked the museum visit",
            finishReason: "stop"
          };
        }
      })
    });

    const handoff = createAgentHandoff({
      source,
      toAgentId: "booking"
    });
    const result = await runAgentHandoff(specialist, handoff);

    expect(seenHandoff).toBe(true);
    expect(result.state.parentRunId).toBe(source.state.runId);
    expect(result.state.handoff?.toAgentId).toBe("booking");
  });

  it("emits agent telemetry for lifecycle, memory, approvals, and handoffs", async () => {
    const events: string[] = [];
    const memory = createInMemoryAgentMemoryStore({
      initialMessages: {
        telemetry: [createTextMessage("assistant", "Previous context")]
      }
    });

    const source = await runAgent(
      createAgent({
        id: "source",
        model: createLanguageModel()
      }),
      { prompt: "hello" }
    );

    const handoff = createAgentHandoff({
      source,
      toAgentId: "telemetry"
    });

    const agent = createAgent({
      id: "telemetry",
      memory,
      onTelemetryEvent(event) {
        events.push(event.type);
      },
      model: createLanguageModel({
        async generate() {
          return {
            messages: [
              {
                role: "assistant",
                parts: [
                  {
                    type: "provider-data",
                    provider: "openai",
                    data: {
                      type: "mcp_approval_request",
                      id: "mcpr_1",
                      arguments: "{}",
                      name: "fetch_docs"
                    }
                  }
                ]
              }
            ],
            finishReason: "stop"
          };
        }
      })
    });

    await runAgent(agent, {
      prompt: "Use MCP",
      handoff
    });

    expect(events).toEqual(
      expect.arrayContaining(["run-start", "memory-loaded", "handoff", "step-start", "approval-request", "run-finish"])
    );
  });
});
