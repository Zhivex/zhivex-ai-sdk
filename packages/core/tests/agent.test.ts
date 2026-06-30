import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Agent,
  agentApprovalResponsePart,
  cancelAgentRun,
  cancelAgentRunTree,
  createAgent,
  createAgentHandoff,
  createAgentApprovalMessage,
  createAgentRunSnapshot,
  createAgentRunTreeSnapshot,
  createAgentTraceArtifact,
  createHierarchicalAgentTrace,
  createFileAgentMemoryStore,
  createFileAgentRunStore,
  createInMemoryAgentMemoryStore,
  createInMemoryAgentRunStore,
  createPostgresAgentMemoryStore,
  createPostgresAgentRunStore,
  createSqliteAgentMemoryStore,
  createSqliteAgentRunStore,
  createTextMessage,
  getAgentApprovalRequests,
  replayAgentRun,
  prepareSubagentsForAgent,
  resumeAgent,
  runAgent,
  runAgentGroup,
  runAgentHandoff,
  streamAgent,
  summarizeAgentTrace,
  toUIAgentStreamResponse,
  toUIMessageStream,
  tool,
  ValidationError,
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
  private idempotencyTables = new Map<string, Map<string, string>>();
  private parentTables = new Map<string, Map<string, string>>();

  exec(sql: string) {
    const match = sql.match(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (!match) {
      return;
    }

    const tableName = match[1]!;
    if (sql.includes("idempotency_key")) {
      this.idempotencyTables.set(tableName, this.idempotencyTables.get(tableName) ?? new Map());
      return;
    }

    if (sql.includes("parent_run_id")) {
      this.parentTables.set(tableName, this.parentTables.get(tableName) ?? new Map());
      return;
    }

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
          if (sql.includes("idempotency_key")) {
            this.idempotencyTables.get(tableName)?.set(String(values[0]), String(values[1]));
            return;
          }

          if (sql.includes("parent_run_id")) {
            this.parentTables.get(tableName)?.set(String(values[0]), String(values[1]));
            return;
          }

          if (sql.includes("run_id")) {
            this.runTables.get(tableName)?.set(String(values[0]), String(values[1]));
            return;
          }

          this.memoryTables.get(tableName)?.set(String(values[0]), String(values[1]));
          return;
        }

        if (deleteMatch) {
          const tableName = deleteMatch[1]!;
          if (this.idempotencyTables.has(tableName)) {
            const runId = String(values[0]);
            const table = this.idempotencyTables.get(tableName);
            for (const [key, mappedRunId] of table ?? []) {
              if (mappedRunId === runId) {
                table?.delete(key);
              }
            }
            return;
          }

          if (this.parentTables.has(tableName)) {
            this.parentTables.get(tableName)?.delete(String(values[0]));
            return;
          }

          this.runTables.get(tableName)?.delete(String(values[0]));
        }
      },
      get: (params?: readonly unknown[]) => {
        const values = [...(params ?? [])];
        const selectMatch = sql.match(/SELECT\s+.+\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
        if (!selectMatch) {
          return undefined;
        }

        const tableName = selectMatch[1]!;
        if (sql.includes("idempotency_key")) {
          const joinMatch = sql.match(/JOIN\s+([A-Za-z_][A-Za-z0-9_]*)/i);
          const idempotencyTableName = joinMatch?.[1];
          const runId = idempotencyTableName ? this.idempotencyTables.get(idempotencyTableName)?.get(String(values[0])) : undefined;
          const stateJson = runId ? this.runTables.get(tableName)?.get(runId) : undefined;
          return stateJson ? ({ state_json: stateJson } as TResult) : undefined;
        }

        if (sql.includes("parent_run_id")) {
          const joinMatch = sql.match(/JOIN\s+([A-Za-z_][A-Za-z0-9_]*)/i);
          const parentTableName = joinMatch?.[1];
          const parentTable = parentTableName ? this.parentTables.get(parentTableName) : undefined;
          const runId = [...(parentTable ?? [])].find(([, mappedParentRunId]) => mappedParentRunId === String(values[0]))?.[0];
          const stateJson = runId ? this.runTables.get(tableName)?.get(runId) : undefined;
          return stateJson ? ({ state_json: stateJson } as TResult) : undefined;
        }

        if (sql.includes("state_json")) {
          const stateJson = this.runTables.get(tableName)?.get(String(values[0]));
          return stateJson ? ({ state_json: stateJson } as TResult) : undefined;
        }

        const messagesJson = this.memoryTables.get(tableName)?.get(String(values[0]));
        return messagesJson ? ({ messages_json: messagesJson } as TResult) : undefined;
      },
      all: (params?: readonly unknown[]) => {
        const values = [...(params ?? [])];
        const selectMatch = sql.match(/SELECT\s+.+\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
        if (!selectMatch || !sql.includes("parent_run_id")) {
          return [];
        }

        const tableName = selectMatch[1]!;
        const joinMatch = sql.match(/JOIN\s+([A-Za-z_][A-Za-z0-9_]*)/i);
        const parentTableName = joinMatch?.[1];
        const parentTable = parentTableName ? this.parentTables.get(parentTableName) : undefined;
        return [...(parentTable ?? [])].flatMap(([runId, mappedParentRunId]) => {
          if (mappedParentRunId !== String(values[0])) {
            return [];
          }
          const stateJson = this.runTables.get(tableName)?.get(runId);
          return stateJson ? ([{ state_json: stateJson }] as TResult[]) : [];
        });
      }
    };
  }
}

class FakePostgresClient implements PostgresClientLike {
  private runTables = new Map<string, Map<string, AgentRunState>>();
  private memoryTables = new Map<string, Map<string, ModelMessage[]>>();
  private idempotencyTables = new Map<string, Map<string, string>>();
  private parentTables = new Map<string, Map<string, string>>();

  async query<TResult extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    const createMatch = sql.match(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (createMatch) {
      const tableName = createMatch[1]!;
      if (sql.includes("idempotency_key")) {
        this.idempotencyTables.set(tableName, this.idempotencyTables.get(tableName) ?? new Map());
      } else if (sql.includes("parent_run_id")) {
        this.parentTables.set(tableName, this.parentTables.get(tableName) ?? new Map());
      } else if (sql.includes("run_id")) {
        this.runTables.set(tableName, this.runTables.get(tableName) ?? new Map());
      } else {
        this.memoryTables.set(tableName, this.memoryTables.get(tableName) ?? new Map());
      }
      return { rows: [] as TResult[] };
    }

    const insertMatch = sql.match(/INSERT INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (insertMatch) {
      const tableName = insertMatch[1]!;
      if (sql.includes("idempotency_key")) {
        this.idempotencyTables.get(tableName)?.set(String(params[0]), String(params[1]));
      } else if (sql.includes("parent_run_id")) {
        this.parentTables.get(tableName)?.set(String(params[0]), String(params[1]));
      } else if (sql.includes("run_id")) {
        this.runTables.get(tableName)?.set(String(params[0]), JSON.parse(String(params[1])) as AgentRunState);
      } else {
        this.memoryTables.get(tableName)?.set(String(params[0]), JSON.parse(String(params[1])) as ModelMessage[]);
      }
      return { rows: [] as TResult[] };
    }

    const selectMatch = sql.match(/SELECT\s+.+\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (selectMatch) {
      const tableName = selectMatch[1]!;
      if (sql.includes("idempotency_key")) {
        const joinMatch = sql.match(/JOIN\s+([A-Za-z_][A-Za-z0-9_]*)/i);
        const idempotencyTableName = joinMatch?.[1];
        const runId = idempotencyTableName ? this.idempotencyTables.get(idempotencyTableName)?.get(String(params[0])) : undefined;
        const state = runId ? this.runTables.get(tableName)?.get(runId) : undefined;
        return { rows: state ? ([{ state_json: state }] as TResult[]) : [] };
      }

      if (sql.includes("parent_run_id")) {
        const joinMatch = sql.match(/JOIN\s+([A-Za-z_][A-Za-z0-9_]*)/i);
        const parentTableName = joinMatch?.[1];
        const parentTable = parentTableName ? this.parentTables.get(parentTableName) : undefined;
        const states = [...(parentTable ?? [])].flatMap(([runId, mappedParentRunId]) => {
          if (mappedParentRunId !== String(params[0])) {
            return [];
          }
          const state = this.runTables.get(tableName)?.get(runId);
          return state ? ([{ state_json: state }] as TResult[]) : [];
        });
        return { rows: states };
      }

      if (sql.includes("state_json")) {
        const state = this.runTables.get(tableName)?.get(String(params[0]));
        return { rows: state ? ([{ state_json: state }] as TResult[]) : [] };
      }

      const messages = this.memoryTables.get(tableName)?.get(String(params[0]));
      return { rows: messages ? ([{ messages_json: messages }] as TResult[]) : [] };
    }

    const deleteMatch = sql.match(/DELETE FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (deleteMatch) {
      const tableName = deleteMatch[1]!;
      if (this.idempotencyTables.has(tableName)) {
        const runId = String(params[0]);
        const table = this.idempotencyTables.get(tableName);
        for (const [key, mappedRunId] of table ?? []) {
          if (mappedRunId === runId) {
            table?.delete(key);
          }
        }
      } else if (this.parentTables.has(tableName)) {
        this.parentTables.get(tableName)?.delete(String(params[0]));
      } else {
        this.runTables.get(tableName)?.delete(String(params[0]));
      }
    }

    return { rows: [] as TResult[] };
  }
}

describe("agent runtime", () => {
  it("runs, streams, and resumes through the Agent class facade", async () => {
    let calls = 0;
    const agent = new Agent({
      id: "class-agent",
      model: createLanguageModel({
        async generate() {
          calls += 1;
          return {
            messages: [createTextMessage("assistant", `reply ${calls}`)],
            text: `reply ${calls}`,
            finishReason: "stop"
          };
        },
        async stream() {
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "text-delta", textDelta: "streamed" };
            yield { type: "finish", finishReason: "stop" };
          })();
        }
      }),
      maxSteps: 2,
      metadata: { owner: "agents-release" }
    });

    const run = await agent.run({ prompt: "Hello" });
    expect(run.status).toBe("completed");
    expect(run.outputText).toBe("reply 1");
    expect(run.state.agentId).toBe("class-agent");
    expect(run.state.metadata).toEqual({ owner: "agents-release" });

    const defaultRun = await agent.run();
    expect(defaultRun.status).toBe("completed");
    expect(defaultRun.outputText).toBe("reply 2");

    let approvalCalls = 0;
    const approvalAgent = new Agent({
      model: createLanguageModel({
        async generate(input) {
          approvalCalls += 1;
          if (approvalCalls === 1) {
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
                        id: "mcpr_class",
                        arguments: "{}",
                        name: "fetch_docs"
                      }
                    }
                  ]
                }
              ],
              text: "Need approval",
              finishReason: "stop"
            };
          }

          const sawApprovalResponse = input.messages.some((message) =>
            message.parts.some(
              (part) =>
                part.type === "provider-data" &&
                part.provider === "openai" &&
                (part.data as { type?: string }).type === "mcp_approval_response"
            )
          );

          return {
            messages: [createTextMessage("assistant", sawApprovalResponse ? "Approved" : "Missing approval")],
            text: sawApprovalResponse ? "Approved" : "Missing approval",
            finishReason: "stop"
          };
        }
      }),
      maxSteps: 2
    });
    const waiting = await approvalAgent.run({ prompt: "Fetch docs" });
    expect(waiting.status).toBe("waiting_approval");

    const resumed = await approvalAgent.resume({
      state: waiting.state,
      approvals: [
        {
          provider: "openai",
          approvalRequestId: "mcpr_class",
          approve: true
        }
      ]
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.outputText).toBe("Approved");

    const streamed = agent.stream({ prompt: "Stream" });
    await expect(Array.fromAsync(streamed.textStream)).resolves.toEqual(["streamed"]);
    await expect(streamed.collect()).resolves.toMatchObject({
      status: "completed",
      outputText: "streamed"
    });

    expect(agent.toDefinition()).toMatchObject({
      id: "class-agent",
      maxSteps: 2,
      metadata: { owner: "agents-release" }
    });
  });

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

    expect(result.status).toBe("waiting_approval");
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

  it("resumes an agent waiting for approval when approval responses are provided", async () => {
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

  it("accepts legacy suspended states while resuming approvals", async () => {
    let sawApproval = false;
    const agent = createAgent({
      model: createLanguageModel({
        async generate(input) {
          sawApproval = input.messages.some((message) =>
            message.parts.some(
              (part) =>
                part.type === "provider-data" &&
                part.provider === "openai" &&
                (part.data as { type?: string }).type === "mcp_approval_response"
            )
          );

          return {
            messages: [createTextMessage("assistant", "legacy resumed")],
            text: "legacy resumed",
            finishReason: "stop"
          };
        }
      }),
      maxSteps: 2
    });
    const legacyState = {
      schemaVersion: 1,
      runId: "legacy-suspended",
      provider: "test",
      modelId: "agent-model",
      status: "suspended",
      messages: [createTextMessage("user", "Use MCP")],
      steps: [],
      toolResults: [],
      currentStep: 0,
      maxSteps: 2,
      outputText: "",
      pendingApprovals: [
        {
          provider: "openai",
          id: "mcpr_legacy",
          arguments: "{}",
          name: "fetch_docs",
          rawData: {
            type: "mcp_approval_request",
            id: "mcpr_legacy",
            arguments: "{}",
            name: "fetch_docs"
          }
        }
      ]
    } as AgentRunState;

    const resumed = await resumeAgent(agent, {
      state: legacyState,
      approvals: [
        {
          provider: "openai",
          approvalRequestId: "mcpr_legacy",
          approve: true
        }
      ]
    });

    expect(sawApproval).toBe(true);
    expect(resumed.status).toBe("completed");
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
      status: "waiting_approval"
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

  it("reuses existing runs by idempotency key", async () => {
    let calls = 0;
    const store = createInMemoryAgentRunStore();
    const agent = createAgent({
      id: "idempotent-agent",
      model: createLanguageModel({
        async generate() {
          calls += 1;
          return {
            messages: [createTextMessage("assistant", `call ${calls}`)],
            text: `call ${calls}`,
            finishReason: "stop"
          };
        }
      }),
      store
    });

    const first = await runAgent(agent, {
      prompt: "Do this once",
      idempotencyKey: "agent-run-key-1"
    });
    const second = await runAgent(agent, {
      prompt: "Do this once",
      idempotencyKey: "agent-run-key-1"
    });

    expect(first.state.runId).toBe(second.state.runId);
    expect(second.outputText).toBe("call 1");
    expect(second.state.schemaVersion).toBe(1);
    expect(second.state.idempotencyKey).toBe("agent-run-key-1");
    expect(calls).toBe(1);
  });

  it("requires a store with idempotency lookup when idempotency keys are used", async () => {
    const agentWithoutStore = createAgent({
      id: "no-store-agent",
      model: createLanguageModel()
    });
    await expect(runAgent(agentWithoutStore, { prompt: "once", idempotencyKey: "missing-store" })).rejects.toThrow(
      ValidationError
    );

    const agentWithoutLookup = createAgent({
      id: "custom-store-agent",
      model: createLanguageModel(),
      store: {
        load: () => undefined,
        save: () => undefined
      }
    });
    await expect(runAgent(agentWithoutLookup, { prompt: "once", idempotencyKey: "missing-lookup" })).rejects.toThrow(
      ValidationError
    );
  });

  it("normalizes legacy run state to schema version 1 when resuming", async () => {
    const store = createInMemoryAgentRunStore();
    const legacyState = {
      runId: "legacy-run",
      provider: "test",
      modelId: "agent-model",
      status: "failed",
      messages: [createTextMessage("user", "Weather in Madrid?")],
      steps: [],
      toolResults: [],
      currentStep: 0,
      maxSteps: 1,
      outputText: "",
      pendingApprovals: []
    } as AgentRunState;
    await Promise.resolve(store.save(legacyState));

    const result = await runAgent(
      createAgent({
        id: "legacy-agent",
        model: createLanguageModel(),
        store
      }),
      {
        runId: "legacy-run"
      }
    );

    expect(result.status).toBe("completed");
    expect(result.state.schemaVersion).toBe(1);
    await expect(Promise.resolve(store.load("legacy-run"))).resolves.toMatchObject({ schemaVersion: 1 });
  });

  it("marks persisted runs cancel_requested by default and skips model execution", async () => {
    let calls = 0;
    const store = createInMemoryAgentRunStore();
    const agent = createAgent({
      id: "cancel-agent",
      model: createLanguageModel({
        async generate() {
          calls += 1;
          return {
            messages: [createTextMessage("assistant", "before cancel")],
            text: "before cancel",
            finishReason: "stop"
          };
        }
      }),
      store
    });

    const first = await runAgent(agent, { prompt: "cancel me later" });
    const cancelled = await cancelAgentRun(store, first.state.runId, { reason: "User cancelled." });
    const resumed = await runAgent(agent, { runId: first.state.runId });

    expect(cancelled).toMatchObject({
      status: "cancel_requested",
      schemaVersion: 1,
      cancellationReason: "User cancelled."
    });
    expect(cancelled?.cancelledAt).toBeTypeOf("number");
    expect(resumed.status).toBe("cancel_requested");
    expect(calls).toBe(1);
  });

  it("can mark persisted runs as finally cancelled", async () => {
    const store = createInMemoryAgentRunStore();
    const first = await runAgent(
      createAgent({
        id: "cancel-final-agent",
        model: createLanguageModel(),
        store
      }),
      { prompt: "cancel final" }
    );

    const cancelled = await cancelAgentRun(store, first.state.runId, {
      reason: "Final cancellation.",
      mode: "final"
    });

    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancellationReason: "Final cancellation."
    });
  });

  it("returns timed_out when an agent policy timeout expires", async () => {
    let aborted = false;
    const agent = createAgent({
      id: "timeout-agent",
      model: createLanguageModel({
        async generate(input) {
          await new Promise((resolve, reject) => {
            input.abortSignal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("model aborted"));
              },
              { once: true }
            );
            setTimeout(resolve, 50);
          });
          return {
            messages: [createTextMessage("assistant", "too late")],
            text: "too late"
          };
        }
      }),
      policy: {
        timeoutMs: 5
      }
    });

    const result = await runAgent(agent, { prompt: "slow" });

    expect(result.status).toBe("timed_out");
    expect(result.error?.message).toContain("timed out");
    expect(aborted).toBe(true);
  });

  it("can convert an agent policy timeout into cancel_requested", async () => {
    const agent = createAgent({
      id: "timeout-cancel-agent",
      model: createLanguageModel({
        async generate() {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            messages: [createTextMessage("assistant", "too late")],
            text: "too late"
          };
        }
      })
    });

    const result = await runAgent(agent, {
      prompt: "slow",
      policy: {
        timeoutMs: 5,
        onTimeout: "cancel-requested"
      }
    });

    expect(result.status).toBe("cancel_requested");
    expect(result.state.cancellationReason).toContain("timed out");
  });

  it("looks up and deletes in-memory runs by parent run id", async () => {
    const store = createInMemoryAgentRunStore();
    await Promise.resolve(store.save({
      schemaVersion: 1,
      runId: "memory-child",
      parentRunId: "memory-parent",
      provider: "test",
      modelId: "agent-model",
      status: "completed",
      messages: [],
      steps: [],
      toolResults: [],
      currentStep: 0,
      maxSteps: 1,
      outputText: "child",
      pendingApprovals: []
    }));

    await expect(Promise.resolve(store.findByParentRunId?.("memory-parent"))).resolves.toEqual([
      expect.objectContaining({ runId: "memory-child", parentRunId: "memory-parent" })
    ]);

    await Promise.resolve(store.delete?.("memory-child"));
    await expect(Promise.resolve(store.findByParentRunId?.("memory-parent"))).resolves.toEqual([]);
  });

  it("cancels persisted parent and child runs as a tree", async () => {
    const store = createInMemoryAgentRunStore();
    await Promise.resolve(store.save({
      schemaVersion: 1,
      runId: "parent-run",
      agentId: "parent",
      provider: "test",
      modelId: "agent-model",
      status: "completed",
      messages: [],
      steps: [],
      toolResults: [],
      currentStep: 0,
      maxSteps: 1,
      outputText: "parent",
      pendingApprovals: []
    }));
    await Promise.resolve(store.save({
      schemaVersion: 1,
      runId: "child-run",
      agentId: "child",
      parentRunId: "parent-run",
      provider: "test",
      modelId: "agent-model",
      status: "completed",
      messages: [],
      steps: [],
      toolResults: [],
      currentStep: 0,
      maxSteps: 1,
      outputText: "child",
      pendingApprovals: []
    }));

    const result = await cancelAgentRunTree(store, "parent-run", { reason: "Stop workflow." });

    expect(result.parent).toMatchObject({ runId: "parent-run", status: "cancel_requested", cancellationReason: "Stop workflow." });
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({ runId: "child-run", status: "cancel_requested", cancellationReason: "Stop workflow." });
    await expect(Promise.resolve(store.load("child-run"))).resolves.toMatchObject({ status: "cancel_requested" });
  });

  it("requires parent lookup support for tree cancellation", async () => {
    await expect(
      cancelAgentRunTree(
        {
          load: () => undefined,
          save: () => undefined
        },
        "parent-run"
      )
    ).rejects.toThrow(ValidationError);
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

    const saved = JSON.parse(await readFile(path.join(directory, `${encodeURIComponent(result.state.runId)}.json`), "utf8")) as {
      runId: string;
      outputText: string;
    };
    expect(saved.runId).toBe(result.state.runId);
    expect(saved.outputText).toBe("hello world");
    await expect(Promise.resolve(store.findByIdempotencyKey?.("missing-key"))).resolves.toBeUndefined();
    await expect(Promise.resolve(store.findByParentRunId?.("missing-parent"))).resolves.toEqual([]);
  });

  it("keeps file-backed run ids inside the configured directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-agent-store-"));
    const directory = path.join(root, "runs");
    const store = createFileAgentRunStore({ directory });
    const createState = (runId: string): AgentRunState => ({
      schemaVersion: 1,
      runId,
      provider: "test",
      modelId: "agent-model",
      status: "completed",
      messages: [],
      steps: [],
      toolResults: [],
      currentStep: 0,
      maxSteps: 1,
      outputText: runId,
      pendingApprovals: []
    });

    for (const runId of ["../escape", "folder/child", "/tmp/escape"]) {
      await Promise.resolve(store.save(createState(runId)));
      await expect(Promise.resolve(store.load(runId))).resolves.toMatchObject({ runId, outputText: runId });
      await expect(readFile(path.join(directory, `${encodeURIComponent(runId)}.json`), "utf8")).resolves.toContain(runId);
    }

    await expect(readFile(path.join(root, "escape.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await Promise.resolve(store.delete?.("../escape"));
    await expect(readFile(path.join(directory, `${encodeURIComponent("../escape")}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, "escape.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps file-backed memory keys inside the configured directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-agent-memory-"));
    const directory = path.join(root, "memory");
    const createState = (runId: string, agentId?: string): AgentRunState => ({
      schemaVersion: 1,
      runId,
      agentId,
      provider: "test",
      modelId: "agent-model",
      status: "completed",
      messages: [{ role: "assistant", content: `memory:${agentId ?? runId}` }],
      steps: [],
      toolResults: [],
      currentStep: 0,
      maxSteps: 1,
      outputText: "",
      pendingApprovals: []
    });

    const defaultStore = createFileAgentMemoryStore({ directory });
    await Promise.resolve(defaultStore.save({ runId: "ignored", agentId: "../memory", state: createState("ignored", "../memory") }));
    await expect(Promise.resolve(defaultStore.load({ runId: "ignored", agentId: "../memory" }))).resolves.toEqual([
      { role: "assistant", content: "memory:../memory" }
    ]);
    await expect(readFile(path.join(directory, `${encodeURIComponent("../memory")}.json`), "utf8")).resolves.toContain("memory:../memory");

    await Promise.resolve(defaultStore.save({ runId: "../memory-run", state: createState("../memory-run") }));
    await expect(Promise.resolve(defaultStore.load({ runId: "../memory-run" }))).resolves.toEqual([
      { role: "assistant", content: "memory:../memory-run" }
    ]);

    const customStore = createFileAgentMemoryStore({
      directory,
      key: () => "/tmp/custom-memory"
    });
    await Promise.resolve(customStore.save({ runId: "custom", state: createState("custom") }));
    await expect(Promise.resolve(customStore.load({ runId: "custom" }))).resolves.toEqual([
      { role: "assistant", content: "memory:custom" }
    ]);
    await expect(readFile(path.join(directory, `${encodeURIComponent("/tmp/custom-memory")}.json`), "utf8")).resolves.toContain("memory:custom");
    await expect(readFile(path.join(root, "memory.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("looks up file-backed runs by parent run id", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-agent-store-"));
    const store = createFileAgentRunStore({ directory });
    await Promise.resolve(store.save({
      schemaVersion: 1,
      runId: "file-child",
      parentRunId: "file-parent",
      provider: "test",
      modelId: "agent-model",
      status: "completed",
      messages: [],
      steps: [],
      toolResults: [],
      currentStep: 0,
      maxSteps: 1,
      outputText: "child",
      pendingApprovals: []
    }));

    await expect(Promise.resolve(store.findByParentRunId?.("file-parent"))).resolves.toEqual([
      expect.objectContaining({ runId: "file-child", parentRunId: "file-parent" })
    ]);

    await Promise.resolve(store.delete?.("file-child"));
    await expect(Promise.resolve(store.findByParentRunId?.("file-parent"))).resolves.toEqual([]);
  });

  it("looks up and deletes file-backed runs by idempotency key", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-agent-store-"));
    const store = createFileAgentRunStore({ directory });
    const result = await runAgent(
      createAgent({
        id: "file-idempotency-agent",
        model: createLanguageModel(),
        store
      }),
      {
        prompt: "Persist this once",
        idempotencyKey: "file-key"
      }
    );

    await expect(Promise.resolve(store.findByIdempotencyKey?.("file-key"))).resolves.toMatchObject({
      runId: result.state.runId,
      schemaVersion: 1
    });

    await Promise.resolve(store.delete?.(result.state.runId));
    await expect(Promise.resolve(store.findByIdempotencyKey?.("file-key"))).resolves.toBeUndefined();
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
    await expect(Promise.resolve(reloaded.findByIdempotencyKey?.("sqlite-key"))).resolves.toBeUndefined();
    await expect(Promise.resolve(reloaded.findByParentRunId?.("sqlite-parent"))).resolves.toEqual([]);

    await Promise.resolve(reloaded.delete?.(first.state.runId));
    await expect(Promise.resolve(reloaded.load(first.state.runId))).resolves.toBeUndefined();
  });

  it("looks up and deletes sqlite-backed runs by idempotency key", async () => {
    const db = new FakeSqliteDatabase();
    const store = createSqliteAgentRunStore({
      db,
      tableName: "agent_runs"
    });
    const result = await runAgent(
      createAgent({
        id: "sqlite-idempotency-agent",
        model: createLanguageModel(),
        store
      }),
      {
        prompt: "Persist idempotently in sqlite",
        idempotencyKey: "sqlite-key"
      }
    );

    await expect(Promise.resolve(store.findByIdempotencyKey?.("sqlite-key"))).resolves.toMatchObject({
      runId: result.state.runId,
      schemaVersion: 1
    });

    await Promise.resolve(store.delete?.(result.state.runId));
    await expect(Promise.resolve(store.findByIdempotencyKey?.("sqlite-key"))).resolves.toBeUndefined();
  });

  it("looks up and deletes sqlite-backed runs by parent run id", async () => {
    const db = new FakeSqliteDatabase();
    const store = createSqliteAgentRunStore({
      db,
      tableName: "agent_runs"
    });
    await Promise.resolve(store.save({
      schemaVersion: 1,
      runId: "sqlite-child",
      parentRunId: "sqlite-parent",
      provider: "test",
      modelId: "agent-model",
      status: "completed",
      messages: [],
      steps: [],
      toolResults: [],
      currentStep: 0,
      maxSteps: 1,
      outputText: "child",
      pendingApprovals: []
    }));

    await expect(Promise.resolve(store.findByParentRunId?.("sqlite-parent"))).resolves.toEqual([
      expect.objectContaining({ runId: "sqlite-child", parentRunId: "sqlite-parent" })
    ]);

    await Promise.resolve(store.delete?.("sqlite-child"));
    await expect(Promise.resolve(store.findByParentRunId?.("sqlite-parent"))).resolves.toEqual([]);
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
    await expect(reloaded.findByIdempotencyKey?.("postgres-key")).resolves.toBeUndefined();
    await expect(reloaded.findByParentRunId?.("postgres-parent")).resolves.toEqual([]);

    await reloaded.delete?.(first.state.runId);
    await expect(reloaded.load(first.state.runId)).resolves.toBeUndefined();
  });

  it("rejects Postgres agent stores without query()", () => {
    expect(() =>
      createPostgresAgentRunStore({
        client: {} as PostgresClientLike
      })
    ).toThrow(/app-owned Postgres-compatible client/);

    expect(() =>
      createPostgresAgentMemoryStore({
        client: {} as PostgresClientLike
      })
    ).toThrow(/app-owned Postgres-compatible client/);
  });

  it("looks up and deletes postgres-backed runs by idempotency key", async () => {
    const client = new FakePostgresClient();
    const store = createPostgresAgentRunStore({
      client,
      tableName: "agent_runs"
    });
    const result = await runAgent(
      createAgent({
        id: "postgres-idempotency-agent",
        model: createLanguageModel(),
        store
      }),
      {
        prompt: "Persist idempotently in postgres",
        idempotencyKey: "postgres-key"
      }
    );

    await expect(store.findByIdempotencyKey?.("postgres-key")).resolves.toMatchObject({
      runId: result.state.runId,
      schemaVersion: 1
    });

    await store.delete?.(result.state.runId);
    await expect(store.findByIdempotencyKey?.("postgres-key")).resolves.toBeUndefined();
  });

  it("looks up and deletes postgres-backed runs by parent run id", async () => {
    const client = new FakePostgresClient();
    const store = createPostgresAgentRunStore({
      client,
      tableName: "agent_runs"
    });
    await store.save({
      schemaVersion: 1,
      runId: "postgres-child",
      parentRunId: "postgres-parent",
      provider: "test",
      modelId: "agent-model",
      status: "completed",
      messages: [],
      steps: [],
      toolResults: [],
      currentStep: 0,
      maxSteps: 1,
      outputText: "child",
      pendingApprovals: []
    });

    await expect(store.findByParentRunId?.("postgres-parent")).resolves.toEqual([
      expect.objectContaining({ runId: "postgres-child", parentRunId: "postgres-parent" })
    ]);

    await store.delete?.("postgres-child");
    await expect(store.findByParentRunId?.("postgres-parent")).resolves.toEqual([]);
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

  it("runs native subagents as child runs and records hierarchical replay data", async () => {
    const child = createAgent({
      id: "researcher",
      model: createLanguageModel({
        async generate(input) {
          expect(input.messages.at(-1)?.parts[0]).toMatchObject({
            type: "text",
            text: "Find sources"
          });
          return {
            messages: [createTextMessage("assistant", "Research complete")],
            text: "Research complete",
            finishReason: "stop"
          };
        }
      })
    });

    let callCount = 0;
    const parent = createAgent({
      id: "coordinator",
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
                        id: "subagent-call-1",
                        name: "research",
                        input: { prompt: "Find sources" }
                      }
                    }
                  ]
                }
              ],
              finishReason: "tool-calls"
            };
          }

          return {
            messages: [createTextMessage("assistant", "Final answer with research")],
            text: "Final answer with research",
            finishReason: "stop"
          };
        }
      }),
      subagents: [
        {
          name: "research",
          agent: child
        }
      ],
      maxSteps: 2
    });

    const result = await runAgent(parent, {
      prompt: "Coordinate research"
    });

    expect(result.status).toBe("completed");
    expect(result.state.childRuns).toHaveLength(1);
    expect(result.state.childRuns?.[0]).toMatchObject({
      agentId: "researcher",
      parentRunId: result.state.runId,
      toolName: "research",
      status: "completed",
      outputText: "Research complete"
    });
    expect(result.toolResults[0]?.output).toMatchObject({
      agentId: "researcher",
      parentRunId: result.state.runId,
      status: "completed"
    });
    expect(createAgentRunSnapshot(result.state).childRuns?.[0]?.agentId).toBe("researcher");
    expect(replayAgentRun(result.state).timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "subagent-run",
          childRun: expect.objectContaining({ agentId: "researcher" })
        })
      ])
    );

    const trace = createAgentTraceArtifact(result.state);
    expect(trace.childRuns?.[0]?.agentId).toBe("researcher");
    expect(summarizeAgentTrace(trace).childRuns).toBe(1);
  });

  it("creates hierarchical snapshots and traces from stored parent-child runs", async () => {
    const store = createInMemoryAgentRunStore();
    const createState = (runId: string, parentRunId?: string): AgentRunState => ({
      schemaVersion: 1,
      runId,
      parentRunId,
      agentId: runId,
      provider: "test",
      modelId: "agent-model",
      status: "completed",
      messages: [],
      steps: [],
      toolResults: [],
      currentStep: 0,
      maxSteps: 1,
      outputText: runId,
      pendingApprovals: []
    });
    await Promise.resolve(store.save(createState("parent")));
    await Promise.resolve(store.save(createState("child", "parent")));
    await Promise.resolve(store.save(createState("grandchild", "child")));

    const snapshot = await createAgentRunTreeSnapshot(store, "parent");
    const trace = await createHierarchicalAgentTrace(store, "parent");

    expect(snapshot).toMatchObject({
      totalRuns: 3,
      root: {
        runId: "parent",
        children: [
          {
            runId: "child",
            children: [{ runId: "grandchild" }]
          }
        ]
      }
    });
    expect(trace).toMatchObject({
      totalRuns: 3,
      root: {
        trace: { runId: "parent" },
        children: [{ trace: { runId: "child" }, children: [{ trace: { runId: "grandchild" } }] }]
      }
    });
    expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
  });

  it("requires parent lookup support for hierarchical traces", async () => {
    const store = {
      load: () => undefined,
      save: () => undefined
    };

    await expect(createAgentRunTreeSnapshot(store, "run")).rejects.toThrow(ValidationError);
    await expect(createHierarchicalAgentTrace(store, "run")).rejects.toThrow(ValidationError);
  });

  it("fails fast when a native subagent tool conflicts with an existing tool", async () => {
    const child = createAgent({
      id: "researcher",
      model: createLanguageModel()
    });
    const agent = createAgent({
      model: createLanguageModel(),
      tools: {
        research: tool({
          name: "research",
          schema: z.object({ query: z.string() }),
          execute: ({ query }) => query
        })
      },
      subagents: [{ name: "research", agent: child }]
    });

    await expect(runAgent(agent, { prompt: "hello" })).rejects.toThrow('Subagent tool "research" conflicts');
  });

  it("runs explicit agent groups in parallel while preserving order", async () => {
    const calls: string[] = [];
    const first = createAgent({
      id: "first",
      model: createLanguageModel({
        async generate() {
          calls.push("first");
          return { messages: [createTextMessage("assistant", "one")], text: "one" };
        }
      })
    });
    const second = createAgent({
      id: "second",
      model: createLanguageModel({
        async generate() {
          calls.push("second");
          return { messages: [createTextMessage("assistant", "two")], text: "two" };
        }
      })
    });

    const group = await runAgentGroup(
      [
        { name: "a", agent: first },
        { name: "b", agent: second }
      ],
      { prompt: "fan out", parentRunId: "parent", metadata: { shared: true } }
    );

    expect(group.status).toBe("completed");
    expect(group.parentRunId).toBe("parent");
    expect(group.outputs.map((output) => output.name)).toEqual(["a", "b"]);
    expect(group.outputs.map((output) => output.output?.state.parentRunId)).toEqual(["parent", "parent"]);
    expect(calls.sort()).toEqual(["first", "second"]);
  });

  it("reports agent group failures without hiding successful outputs", async () => {
    const group = await runAgentGroup(
      [
        { name: "ok", agent: createAgent({ id: "ok", model: createLanguageModel() }) },
        {
          name: "bad",
          agent: createAgent({
            id: "bad",
            model: createLanguageModel({
              async generate() {
                throw new Error("bad failed");
              }
            })
          })
        }
      ],
      { prompt: "fan out", stopOnError: true }
    );

    expect(group.status).toBe("failed");
    expect(group.outputs[0]).toMatchObject({ name: "ok", status: "fulfilled" });
    expect(group.outputs[1]).toMatchObject({ name: "bad", status: "rejected", error: { message: "bad failed" } });
  });

  it("keeps all-settled agent group behavior when stopOnError is false", async () => {
    const calls: string[] = [];
    const group = await runAgentGroup(
      [
        {
          name: "bad",
          agent: createAgent({
            id: "bad",
            model: createLanguageModel({
              async generate() {
                calls.push("bad");
                throw new Error("bad failed");
              }
            })
          })
        },
        {
          name: "ok",
          agent: createAgent({
            id: "ok",
            model: createLanguageModel({
              async generate() {
                calls.push("ok");
                return { messages: [createTextMessage("assistant", "ok")], text: "ok" };
              }
            })
          })
        }
      ],
      { prompt: "fan out", stopOnError: false }
    );

    expect(group.status).toBe("failed");
    expect(group.outputs[0]).toMatchObject({ name: "bad", status: "rejected" });
    expect(group.outputs[1]).toMatchObject({ name: "ok", status: "fulfilled" });
    expect(calls.sort()).toEqual(["bad", "ok"]);
  });

  it("aborts pending agent group members after the first fail-fast exception", async () => {
    let slowAborted = false;
    const group = await runAgentGroup(
      [
        {
          name: "bad",
          agent: createAgent({
            id: "bad",
            model: createLanguageModel({
              async generate() {
                throw new Error("bad failed");
              }
            })
          })
        },
        {
          name: "slow",
          agent: createAgent({
            id: "slow",
            model: createLanguageModel({
              async generate(input) {
                await new Promise((resolve, reject) => {
                  input.abortSignal?.addEventListener(
                    "abort",
                    () => {
                      slowAborted = true;
                      reject(new Error("slow aborted"));
                    },
                    { once: true }
                  );
                  setTimeout(resolve, 50);
                });
                return { messages: [createTextMessage("assistant", "slow")], text: "slow" };
              }
            })
          })
        }
      ],
      { prompt: "fan out", stopOnError: true }
    );

    expect(group.status).toBe("failed");
    expect(slowAborted).toBe(true);
    expect(group.outputs[0]).toMatchObject({ name: "bad", status: "rejected", error: { message: "bad failed" } });
    expect(group.outputs[1]).toMatchObject({
      name: "slow",
      status: "rejected",
      error: { message: "Agent group member aborted after fail-fast." }
    });
  });

  it("aborts pending agent group members after a failed output status", async () => {
    let slowAborted = false;
    const group = await runAgentGroup(
      [
        {
          name: "failed-output",
          agent: createAgent({
            id: "failed-output",
            model: createLanguageModel(),
            inputGuardrails: [
              () => ({
                triggered: true,
                reason: "blocked"
              })
            ]
          })
        },
        {
          name: "slow",
          agent: createAgent({
            id: "slow-output",
            model: createLanguageModel({
              async generate(input) {
                await new Promise((resolve, reject) => {
                  input.abortSignal?.addEventListener(
                    "abort",
                    () => {
                      slowAborted = true;
                      reject(new Error("slow aborted"));
                    },
                    { once: true }
                  );
                  setTimeout(resolve, 50);
                });
                return { messages: [createTextMessage("assistant", "slow")], text: "slow" };
              }
            })
          })
        }
      ],
      { prompt: "fan out", stopOnError: true }
    );

    expect(group.status).toBe("failed");
    expect(slowAborted).toBe(true);
    expect(group.outputs[0]).toMatchObject({ name: "failed-output", status: "fulfilled", output: { status: "failed" } });
    expect(group.outputs[1]).toMatchObject({
      name: "slow",
      status: "rejected",
      error: { message: "Agent group member aborted after fail-fast." }
    });
  });

  it("prepares subagents with shared defaults without mutating originals", () => {
    const store = createInMemoryAgentRunStore();
    const memory = createInMemoryAgentMemoryStore();
    const telemetry = () => undefined;
    const approval = () => true;
    const child = createAgent({
      id: "child",
      model: createLanguageModel()
    });
    const parent = createAgent({
      id: "parent",
      model: createLanguageModel(),
      store,
      memory,
      onTelemetryEvent: telemetry,
      toolApprovalPolicy: approval,
      toolExecution: { parallel: false },
      metadata: { parent: true },
      subagents: [{ name: "child", agent: child, metadata: { role: "helper" } }]
    });

    const prepared = prepareSubagentsForAgent(parent, { metadata: { prepared: true } });

    expect(parent.subagents?.[0]?.agent.store).toBeUndefined();
    expect(prepared.subagents?.[0]?.agent.store).toBe(store);
    expect(prepared.subagents?.[0]?.agent.memory).toBe(memory);
    expect(prepared.subagents?.[0]?.agent.onTelemetryEvent).toBe(telemetry);
    expect(prepared.subagents?.[0]?.agent.toolApprovalPolicy).toBe(approval);
    expect(prepared.subagents?.[0]?.agent.toolExecution).toEqual({ parallel: false });
    expect(prepared.subagents?.[0]?.agent.metadata).toMatchObject({ parent: true, prepared: true });
    expect(prepared.subagents?.[0]?.metadata).toMatchObject({ role: "helper", prepared: true });
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
