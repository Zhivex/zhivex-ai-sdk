import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createAgent,
  createFileSessionService,
  createInMemorySessionService,
  createPostgresSessionService,
  createRunner,
  createSqliteSessionService,
  createTextMessage,
  ConflictError,
  migrateAgentSessionRecord,
  normalizeAgentSession,
  pruneFileSessionStore,
  SESSION_SCHEMA_VERSION,
  ValidationError,
  type AgentSession,
  type LanguageModel,
  type PostgresClientLike,
  type SqliteDatabaseLike,
  type SqliteStatementLike,
  type StreamEvent
} from "../src/index.js";

const createLanguageModel = (overrides?: Partial<LanguageModel>): LanguageModel => ({
  provider: "test",
  modelId: "runner-model",
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
      yield { type: "finish", finishReason: "stop" };
    })();
  },
  ...overrides
});

class FakeSqliteSessionDatabase implements SqliteDatabaseLike {
  private sessions = new Map<string, string>();
  mutateBeforeCas = false;

  exec() {
    return;
  }

  prepare<TResult extends Record<string, unknown> = Record<string, unknown>>(sql: string): SqliteStatementLike<TResult> {
    return {
      run: (params?: readonly unknown[]) => {
        const values = [...(params ?? [])];
        if (/INSERT INTO/i.test(sql)) {
          this.sessions.set(String(values[0]), String(values[4]));
          return { changes: 1 };
        }
        if (/UPDATE/i.test(sql)) {
          const key = String(values[5]);
          const expectedUpdatedAt = Number(values[6]);
          const existing = this.sessions.get(key);
          if (this.mutateBeforeCas && existing) {
            const mutated = JSON.parse(existing) as AgentSession;
            mutated.updatedAt += 1;
            this.sessions.set(key, JSON.stringify(mutated));
            this.mutateBeforeCas = false;
          }
          const current = this.sessions.get(key);
          if (!current || (JSON.parse(current) as AgentSession).updatedAt !== expectedUpdatedAt) {
            return { changes: 0 };
          }
          this.sessions.set(key, String(values[3]));
          return { changes: 1 };
        }
      },
      get: (params?: readonly unknown[]) => {
        const values = [...(params ?? [])];
        const sessionJson = this.sessions.get(String(values[0]));
        return sessionJson ? ({ session_json: sessionJson } as TResult) : undefined;
      },
      all: () => []
    };
  }
}

class FakePostgresSessionClient implements PostgresClientLike {
  private sessions = new Map<string, AgentSession>();
  mutateBeforeCas = false;

  async query<TResult extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: TResult[] }> {
    const values = [...(params ?? [])];

    if (/SELECT session_json/i.test(sql)) {
      const session = this.sessions.get(String(values[0]));
      return { rows: session ? ([{ session_json: session }] as TResult[]) : [] };
    }

    if (/INSERT INTO/i.test(sql)) {
      this.sessions.set(String(values[0]), JSON.parse(String(values[4])) as AgentSession);
    }

    if (/UPDATE/i.test(sql)) {
      const key = String(values[0]);
      const expectedUpdatedAt = Number(values[6]);
      const existing = this.sessions.get(key);
      if (this.mutateBeforeCas && existing) {
        this.sessions.set(key, { ...existing, updatedAt: existing.updatedAt + 1 });
        this.mutateBeforeCas = false;
      }
      const current = this.sessions.get(key);
      if (!current || current.updatedAt !== expectedUpdatedAt) {
        return { rows: [] };
      }
      const next = JSON.parse(String(values[4])) as AgentSession;
      this.sessions.set(key, next);
      return { rows: [{ session_json: next }] as TResult[] };
    }

    return { rows: [] };
  }
}

describe("runner sessions", () => {
  it("creates and reuses sessions with user and agent events", async () => {
    const sessionService = createInMemorySessionService();
    const agent = createAgent({ model: createLanguageModel() });
    const runner = createRunner({ appName: "travel", agent, sessionService });

    const first = await runner.run({
      userId: "user_1",
      sessionId: "session_1",
      prompt: "Hello"
    });

    expect(first.session.events.map((event) => event.type)).toEqual([
      "session-created",
      "user-message",
      "agent-run-started",
      "agent-run-finished"
    ]);
    expect(first.session.lastRunState?.runId).toBe(first.output.state.runId);
    expect(first.session.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(first.session.revision).toBeGreaterThanOrEqual(1);

    const second = await runner.run({
      userId: "user_1",
      sessionId: "session_1",
      prompt: "Again"
    });

    expect(second.session.sessionId).toBe("session_1");
    expect(second.session.events.filter((event) => event.type === "session-created")).toHaveLength(1);
    expect(second.session.events.filter((event) => event.type === "user-message")).toHaveLength(2);
  });

  it("injects previous session turns into the next agent run", async () => {
    const seenMessages: Array<Array<{ role: string; text?: string }>> = [];
    const sessionService = createInMemorySessionService();
    const agent = createAgent({
      model: createLanguageModel({
        async generate(input) {
          seenMessages.push(
            input.messages.map((message) => ({
              role: message.role,
              text: message.parts[0]?.type === "text" ? message.parts[0].text : undefined
            }))
          );
          return {
            messages: [createTextMessage("assistant", `reply ${seenMessages.length}`)],
            text: `reply ${seenMessages.length}`,
            finishReason: "stop"
          };
        }
      })
    });
    const runner = createRunner({ appName: "memory", agent, sessionService });

    await runner.run({ userId: "user_1", sessionId: "session_1", prompt: "First" });
    const second = await runner.run({ userId: "user_1", sessionId: "session_1", prompt: "Second" });

    expect(seenMessages[1]).toEqual([
      { role: "user", text: "First" },
      { role: "assistant", text: "reply 1" },
      { role: "user", text: "Second" }
    ]);
    expect(second.output.outputText).toBe("reply 2");
    expect(second.session.lastRunState?.outputText).toBe("reply 2");
  });

  it("persists approval waits and resumes from the session state", async () => {
    let callCount = 0;
    let sawApprovalResponse = false;
    const sessionService = createInMemorySessionService();
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
              text: "Need approval",
              finishReason: "stop"
            };
          }

          sawApprovalResponse = input.messages.some((message) =>
            message.parts.some(
              (part) =>
                part.type === "provider-data" &&
                part.provider === "openai" &&
                (part.data as { type?: string }).type === "mcp_approval_response"
            )
          );

          return {
            messages: [createTextMessage("assistant", "Approved")],
            text: "Approved",
            finishReason: "stop"
          };
        }
      }),
      maxSteps: 3
    });
    const runner = createRunner({ appName: "approvals", agent, sessionService });

    const waiting = await runner.run({
      userId: "user_1",
      sessionId: "session_1",
      prompt: "Use MCP"
    });

    expect(waiting.output.status).toBe("waiting_approval");
    expect(waiting.session.lastRunState?.pendingApprovals).toHaveLength(1);
    expect(waiting.session.events.map((event) => event.type)).toContain("approval-required");

    const resumed = await runner.run({
      userId: "user_1",
      sessionId: "session_1",
      approvals: [
        {
          provider: "openai",
          approvalRequestId: "mcpr_1",
          approve: true
        }
      ]
    });

    expect(sawApprovalResponse).toBe(true);
    expect(resumed.output.status).toBe("completed");
    expect(resumed.output.outputText).toBe("Approved");
    expect(resumed.session.lastRunState?.pendingApprovals).toEqual([]);
  });

  it("records failed agent runs before rethrowing", async () => {
    const sessionService = createInMemorySessionService();
    const agent = createAgent({
      model: createLanguageModel({
        async generate() {
          throw new Error("model unavailable");
        }
      })
    });
    const runner = createRunner({ appName: "failures", agent, sessionService });

    await expect(
      runner.run({
        userId: "user_1",
        sessionId: "session_1",
        prompt: "Hello"
      })
    ).rejects.toThrow("model unavailable");

    const session = await sessionService.loadSession({
      appName: "failures",
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(session?.events.at(-1)).toMatchObject({
      type: "agent-run-failed",
      error: { message: "model unavailable" }
    });
  });

  it("streams through the existing agent stream runtime and persists the final session", async () => {
    const sessionService = createInMemorySessionService();
    const agent = createAgent({ model: createLanguageModel() });
    const runner = createRunner({ appName: "streaming", agent, sessionService });
    const stream = runner.stream({
      userId: "user_1",
      sessionId: "session_1",
      prompt: "Stream"
    });

    const chunks: string[] = [];
    for await (const chunk of stream.textStream) {
      chunks.push(chunk);
    }

    const result = await stream.collect();
    expect(chunks.join("")).toBe("hello");
    expect(result.output.status).toBe("completed");
    expect(result.session.lastRunState?.runId).toBe(result.output.state.runId);
  });

  it("persists file-backed sessions across service instances", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-sessions-"));
    const agent = createAgent({ model: createLanguageModel() });
    const firstRunner = createRunner({
      appName: "files",
      agent,
      sessionService: createFileSessionService({ directory })
    });

    const first = await firstRunner.run({
      userId: "user_1",
      sessionId: "session_1",
      prompt: "Hello"
    });

    const reloadedService = createFileSessionService({ directory });
    const reloaded = await reloadedService.loadSession({
      appName: "files",
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(reloaded?.events.map((event) => event.type)).toEqual(first.session.events.map((event) => event.type));
    expect(reloaded?.lastRunState?.runId).toBe(first.output.state.runId);
  });

  it("normalizes legacy file-backed sessions and rejects future schema versions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-sessions-schema-"));
    const service = createFileSessionService({ directory });
    await service.createSession({
      appName: "schema",
      userId: "user_1",
      sessionId: "session_1"
    });
    const filePath = path.join(directory, (await readdir(directory))[0]!);
    const legacy = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    delete legacy.schemaVersion;
    await writeFile(filePath, JSON.stringify(legacy), "utf8");

    await expect(service.loadSession({
      appName: "schema",
      userId: "user_1",
      sessionId: "session_1"
    })).resolves.toMatchObject({ schemaVersion: SESSION_SCHEMA_VERSION });

    await writeFile(filePath, JSON.stringify({ ...legacy, schemaVersion: 999 }), "utf8");
    await expect(service.loadSession({
      appName: "schema",
      userId: "user_1",
      sessionId: "session_1"
    })).rejects.toThrow(ValidationError);
  });

  it("continues runner context from a durable file-backed session", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-sessions-context-"));
    const seenMessages: Array<Array<{ role: string; text?: string }>> = [];
    const agent = createAgent({
      model: createLanguageModel({
        async generate(input) {
          seenMessages.push(
            input.messages.map((message) => ({
              role: message.role,
              text: message.parts[0]?.type === "text" ? message.parts[0].text : undefined
            }))
          );
          return {
            messages: [createTextMessage("assistant", `reply ${seenMessages.length}`)],
            text: `reply ${seenMessages.length}`,
            finishReason: "stop"
          };
        }
      })
    });

    await createRunner({
      appName: "durable-context",
      agent,
      sessionService: createFileSessionService({ directory })
    }).run({ userId: "user_1", sessionId: "session_1", prompt: "First" });

    await createRunner({
      appName: "durable-context",
      agent,
      sessionService: createFileSessionService({ directory })
    }).run({ userId: "user_1", sessionId: "session_1", prompt: "Second" });

    expect(seenMessages[1]).toEqual([
      { role: "user", text: "First" },
      { role: "assistant", text: "reply 1" },
      { role: "user", text: "Second" }
    ]);
  });

  it("resumes approval waits after reloading a durable file-backed session", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-sessions-approvals-"));
    let callCount = 0;
    let sawApprovalResponse = false;
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

          sawApprovalResponse = input.messages.some((message) =>
            message.parts.some(
              (part) =>
                part.type === "provider-data" &&
                part.provider === "openai" &&
                (part.data as { type?: string }).type === "mcp_approval_response"
            )
          );

          return {
            messages: [createTextMessage("assistant", "Approved")],
            text: "Approved",
            finishReason: "stop"
          };
        }
      }),
      maxSteps: 3
    });

    await createRunner({
      appName: "durable-approvals",
      agent,
      sessionService: createFileSessionService({ directory })
    }).run({ userId: "user_1", sessionId: "session_1", prompt: "Use MCP" });

    const resumed = await createRunner({
      appName: "durable-approvals",
      agent,
      sessionService: createFileSessionService({ directory })
    }).run({
      userId: "user_1",
      sessionId: "session_1",
      approvals: [{ provider: "openai", approvalRequestId: "mcpr_1", approve: true }]
    });

    expect(sawApprovalResponse).toBe(true);
    expect(resumed.output.status).toBe("completed");
  });

  it("persists SQLite-backed sessions with appended events", async () => {
    const service = createSqliteSessionService({ db: new FakeSqliteSessionDatabase() });
    const created = await service.createSession({
      appName: "sqlite",
      userId: "user_1",
      sessionId: "session_1"
    });
    const appended = await service.appendEvent({
      appName: "sqlite",
      userId: "user_1",
      sessionId: "session_1",
      event: {
        id: "evt_1",
        type: "user-message",
        appName: "sqlite",
        userId: "user_1",
        sessionId: "session_1",
        createdAt: Date.now(),
        messages: [createTextMessage("user", "hello")]
      }
    });
    const loaded = await service.loadSession({
      appName: "sqlite",
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(created.events).toEqual([]);
    expect(created.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(created.revision).toBe(1);
    expect(appended.events).toHaveLength(1);
    expect(appended.revision).toBe(2);
    expect(loaded?.events).toHaveLength(1);
  });

  it("persists Postgres-backed sessions with appended events", async () => {
    const service = createPostgresSessionService({ client: new FakePostgresSessionClient() });
    await service.createSession({
      appName: "postgres",
      userId: "user_1",
      sessionId: "session_1"
    });
    await service.appendEvent({
      appName: "postgres",
      userId: "user_1",
      sessionId: "session_1",
      event: {
        id: "evt_1",
        type: "agent-run-started",
        appName: "postgres",
        userId: "user_1",
        sessionId: "session_1",
        createdAt: Date.now()
      }
    });
    const loaded = await service.loadSession({
      appName: "postgres",
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(loaded?.events.map((event) => event.type)).toEqual(["agent-run-started"]);
  });

  it("rejects invalid SQL session table names", () => {
    expect(() =>
      createSqliteSessionService({
        db: new FakeSqliteSessionDatabase(),
        tableName: "bad-name"
      })
    ).toThrow(ValidationError);

    expect(() =>
      createPostgresSessionService({
        client: new FakePostgresSessionClient(),
        tableName: "bad-name"
      })
    ).toThrow(ValidationError);
  });

  it("rejects Postgres session clients without query()", () => {
    expect(() =>
      createPostgresSessionService({
        client: {} as PostgresClientLike
      })
    ).toThrow(/app-owned Postgres-compatible client/);
  });

  it("detects optimistic concurrency conflicts for sessions", async () => {
    const service = createInMemorySessionService();
    const session = await service.createSession({
      appName: "conflict",
      userId: "user",
      sessionId: "session"
    });

    await expect(Promise.resolve(service.saveSession(session, { expectedRevision: session.revision }))).resolves.toBeUndefined();
    expect(() => service.saveSession(session, { expectedRevision: session.revision })).toThrow(ConflictError);
    expect(() =>
      service.appendEvent({
        appName: "conflict",
        userId: "user",
        sessionId: "session",
        expectedRevision: session.revision,
        event: {
          id: "evt_conflict",
          type: "user-message",
          appName: "conflict",
          userId: "user",
          sessionId: "session",
          createdAt: Date.now()
        }
      })
    ).toThrow(ConflictError);
  });

  it("uses SQL compare-and-swap for session expected revisions", async () => {
    const sqliteDb = new FakeSqliteSessionDatabase();
    const sqlite = createSqliteSessionService({ db: sqliteDb });
    const sqliteSession = await sqlite.createSession({
      appName: "sqlite-cas",
      userId: "user",
      sessionId: "session"
    });
    sqliteDb.mutateBeforeCas = true;
    expect(() => sqlite.saveSession(sqliteSession, { expectedRevision: sqliteSession.revision })).toThrow(ConflictError);

    const postgresClient = new FakePostgresSessionClient();
    const postgres = createPostgresSessionService({ client: postgresClient });
    const postgresSession = await postgres.createSession({
      appName: "postgres-cas",
      userId: "user",
      sessionId: "session"
    });
    postgresClient.mutateBeforeCas = true;
    await expect(postgres.saveSession(postgresSession, { expectedRevision: postgresSession.revision })).rejects.toThrow(ConflictError);
  });

  it("exports session schema normalization helpers", () => {
    const normalized = normalizeAgentSession({
      appName: "app",
      userId: "user",
      sessionId: "session",
      createdAt: 1,
      updatedAt: 2,
      events: []
    });

    expect(normalized.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(normalized.revision).toBe(1);
    expect(() => normalizeAgentSession({ ...normalized, schemaVersion: 999 })).toThrow(ValidationError);
    expect(migrateAgentSessionRecord(normalized)).toMatchObject({ schemaVersion: SESSION_SCHEMA_VERSION });
    expect(() => migrateAgentSessionRecord(normalized, 999 as 1)).toThrow(ValidationError);
  });

  it("prunes file-backed sessions by retention policy", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-session-prune-"));
    const service = createFileSessionService({ directory });
    const fileName = (...parts: string[]) => `${parts.map((part) => encodeURIComponent(part)).join("__")}.json`;
    await writeFile(path.join(directory, fileName("app", "user", "old")), JSON.stringify(normalizeAgentSession({
      appName: "app",
      userId: "user",
      sessionId: "old",
      createdAt: 1,
      updatedAt: 10,
      events: []
    })), "utf8");
    await writeFile(path.join(directory, fileName("app", "user", "new")), JSON.stringify(normalizeAgentSession({
      appName: "app",
      userId: "user",
      sessionId: "new",
      createdAt: 1,
      updatedAt: 100,
      events: []
    })), "utf8");

    await expect(pruneFileSessionStore({ directory, keepLast: 1 })).resolves.toMatchObject({
      dryRun: true,
      deletedSessionKeys: ["app:user:old"]
    });
    await expect(pruneFileSessionStore({ directory, keepLast: 1, dryRun: false })).resolves.toMatchObject({
      deletedSessionKeys: ["app:user:old"],
      keptSessionKeys: ["app:user:new"]
    });
    await expect(service.loadSession({ appName: "app", userId: "user", sessionId: "old" })).resolves.toBeUndefined();
  });
});
