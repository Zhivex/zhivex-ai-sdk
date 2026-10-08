import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Agent, createMockLanguageModel, createSqliteAgentRunStore, createInMemoryAgentRunStore, tool, type AgentRunState, type SqliteDatabaseLike } from "../src/index.js";
import { persistFailureState } from "../src/agent/state.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const adapter = (db: DatabaseSync): SqliteDatabaseLike => ({ exec: sql => db.exec(sql), prepare: (sql: string) => {
  const stmt = db.prepare(sql);
  return { run: (p: any = []) => stmt.run(...p), get: (p: any = []) => stmt.get(...p) as any, all: (p: any = []) => stmt.all(...p) as any };
} });
const state = (runId = "run"): AgentRunState => ({ schemaVersion: 1, revision: 0, runId, provider: "mock", modelId: "mock", status: "running", messages: [], steps: [], toolResults: [], currentStep: 0, maxSteps: 500, outputText: "", pendingApprovals: [] });
const result = (id: number) => ({ toolCallId: `read-${id}`, toolName: "read", isError: false, output: { text: "x".repeat(24000) } });

describe("incremental SQLite agent history", () => {
  it("survives hundreds of compacted steps and reopens with exact history and one shared blob", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-history-")); roots.push(root);
    const path = join(root, "runs.sqlite"); let db = new DatabaseSync(path);
    let store = createSqliteAgentRunStore({ db: adapter(db), history: "incremental" });
    let executions = 0;
    const count = 120;
    const agent = new Agent({ model: createMockLanguageModel({ streamEvents: Array.from({ length: count + 1 }, (_, i) => [
      ...(i < count ? [{ type: "tool-call" as const, toolCall: { id: `read-${i}`, name: "read", input: {} } }] : [{ type: "text-delta" as const, textDelta: "done" }]),
      { type: "finish" as const, finishReason: i < count ? "tool-calls" as const : "stop" as const }
    ]) }), store, maxSteps: count + 1,
      tools: { read: tool({ name: "read", schema: z.object({}), execute: () => { executions++; return result(0).output; } }) },
      compaction: { maxMessages: 5, keepRecentMessages: 2, compactor: () => ({ summary: "Inspected." }) }
    });
    const stream = agent.stream({ runId: "long", prompt: "Inspect" });
    await Array.fromAsync(stream.eventStream); const output = await stream.collect();
    expect(output.status).toBe("completed"); expect(executions).toBe(count);
    expect(JSON.stringify(output.state).length).toBeGreaterThan(4194304);
    expect(store.checkpointBytes!(output.state)).toBeLessThan(100000);
    expect(output.state.compactions!.length).toBeGreaterThan(30);
    expect(db.prepare("SELECT count(*) AS n FROM zhivex_agent_runs_blobs").get()!.n).toBe(1);
    db.close(); db = new DatabaseSync(path);
    store = createSqliteAgentRunStore({ db: adapter(db), history: "incremental" });
    expect(await store.load("long")).toEqual(output.state);
    expect(await store.loadHistory!("long", { field: "toolResults", offset: 75, limit: 2 })).toEqual(output.state.toolResults.slice(75, 77));
    expect((await store.list!({ limit: 1 })).items[0]).toEqual(output.state);
    db.close();
  }, 120000);

  it("preserves approval and journal across restart without repeating a mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-approval-history-")); roots.push(root);
    const path = join(root, "runs.sqlite"); let db = new DatabaseSync(path);
    let store = createSqliteAgentRunStore({ db: adapter(db), history: "incremental" });
    let executions = 0;
    const tools = { write: tool({ name: "write", schema: z.object({}), requiresApproval: true, approvalMode: "interrupt", execute: () => { executions++; return { text: "x".repeat(30000) }; } }) };
    const first = await new Agent({ store, tools, maxSteps: 4, model: createMockLanguageModel({ responses: [{ messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "write-1", name: "write", input: {} } }] }], finishReason: "tool-calls" }] }) }).run({ prompt: "Write once" });
    expect(first.status).toBe("waiting_approval"); db.close(); db = new DatabaseSync(path);
    store = createSqliteAgentRunStore({ db: adapter(db), history: "incremental" });
    const restored = (await store.load(first.state.runId))!;
    const agent = new Agent({ store, tools, maxSteps: 4, model: createMockLanguageModel({ responses: [{ text: "done", finishReason: "stop" }] }) });
    const approvals = restored.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true }));
    const output = await agent.resume({ state: restored, approvals });
    expect(output.status).toBe("completed"); expect(executions).toBe(1);
    await expect(agent.resume({ state: restored, approvals })).rejects.toThrow();
    expect(executions).toBe(1); db.close();
  });

  it("migrates legacy saves, isolates scopes, rolls back conflicts and detects missing artifacts", async () => {
    const db = new DatabaseSync(":memory:"); const scope = { tenantId: "one" };
    const legacy = createSqliteAgentRunStore({ db: adapter(db) });
    const initial = { ...state(), scope, toolResults: [result(0)] };
    await legacy.save(initial);
    const store = createSqliteAgentRunStore({ db: adapter(db), history: "incremental" });
    const loaded = (await store.load("run", scope))!;
    await store.save(loaded, { expectedRevision: loaded.revision });
    expect((await store.load("run", scope))!.toolResults).toEqual(initial.toolResults);
    const before = db.prepare("SELECT total_changes() AS n").get()!.n;
    await expect(async () => store.save({ ...loaded, toolResults: [result(1)] }, { expectedRevision: 999 })).rejects.toThrow();
    expect(db.prepare("SELECT total_changes() AS n").get()!.n).toBe(before);
    expect(await store.loadHistory!("run", { field: "toolResults" }, { tenantId: "two" })).toEqual([]);
    db.exec("DELETE FROM zhivex_agent_runs_blobs");
    expect(() => store.load("run", scope)).toThrow(/missing or corrupt/);
    await store.delete!("run", scope);
    expect(db.prepare("SELECT count(*) AS n FROM zhivex_agent_runs_history").get()!.n).toBe(0); db.close();
  });

  it("does not rewrite unchanged history records", async () => {
    const db = new DatabaseSync(":memory:"); const store = createSqliteAgentRunStore({ db: adapter(db), history: "incremental" });
    await store.save({ ...state(), toolResults: [result(0), result(1)] });
    db.exec("CREATE TABLE changes (n INTEGER); CREATE TRIGGER history_updates AFTER UPDATE ON zhivex_agent_runs_history BEGIN INSERT INTO changes VALUES (1); END");
    const loaded = (await store.load("run"))!; loaded.status = "completed";
    await store.save(loaded, { expectedRevision: loaded.revision });
    expect(db.prepare("SELECT count(*) AS n FROM changes").get()!.n).toBe(0); db.close();
  });

  it("persists a terminal failure even when the last durable state has no room for the diagnostic", async () => {
    const store = createInMemoryAgentRunStore(); const original = { ...state(), messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "x".repeat(1000) }] }] };
    await store.save(original); const durable = (await store.load("run"))!;
    const bytes = Buffer.byteLength(JSON.stringify(durable));
    const failed = { ...durable, status: "failed" as const, toolResults: [result(1)], error: { message: `Agent run state is 50000 bytes and exceeds maxStateBytes=${bytes}. Offload large tool outputs to artifacts or raise the explicit limit.` } };
    await persistFailureState({ model: createMockLanguageModel(), store }, failed, { maxStateBytes: bytes });
    const saved = (await store.load("run"))!;
    expect(saved.status).toBe("failed"); expect(saved.error?.diagnosticCode).toBe("AGENT_STATE_LIMIT");
    expect(saved.messages).toEqual(durable.messages);
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(bytes + 4096);
  });
  it("rolls back history and artifacts together if a history write fails", async () => {
    const db = new DatabaseSync(":memory:"); const store = createSqliteAgentRunStore({ db: adapter(db), history: "incremental" });
    await store.save(state()); const before = (await store.load("run"))!;
    db.exec("CREATE TRIGGER reject_history BEFORE INSERT ON zhivex_agent_runs_history WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    expect(() => store.save({ ...before, toolResults: [result(0), result(1)] }, { expectedRevision: before.revision })).toThrow("injected failure");
    expect(await store.load("run")).toEqual(before);
    expect(db.prepare("SELECT count(*) AS n FROM zhivex_agent_runs_blobs").get()!.n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM zhivex_agent_runs_history").get()!.n).toBe(0); db.close();
  });

  it.each([false, true])("an actual state overflow becomes durably failed (stream=%s)", async streamMode => {
    const store = createInMemoryAgentRunStore(); let executions = 0;
    const call = { id: "once", name: "write", input: {} };
    const agent = new Agent({ store, maxSteps: 4, policy: { maxStateBytes: 8000 },
      model: createMockLanguageModel({ responses: [{ messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: call }] }], finishReason: "tool-calls" }],
        streamEvents: [[{ type: "tool-call", toolCall: call }, { type: "finish", finishReason: "tool-calls" }]] }),
      tools: { write: tool({ name: "write", schema: z.object({}), execute: () => { executions++; return result(0).output; } }) }
    });
    if (streamMode) {
      const stream = agent.stream({ runId: "overflow", prompt: "Write once" });
      await Array.fromAsync(stream.eventStream).catch(() => undefined);
      await expect(stream.collect()).rejects.toThrow("maxStateBytes");
    } else await expect(agent.run({ runId: "overflow", prompt: "Write once" })).rejects.toThrow("maxStateBytes");
    expect((await store.load("overflow"))!.status).toBe("failed");
    expect(executions).toBe(1);
  });

  it("hydrates one consistent WAL revision while another connection writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-history-snapshot-")); roots.push(root);
    const filename = join(root, "runs.sqlite"); const db = new DatabaseSync(filename); db.exec("PRAGMA journal_mode=WAL");
    const writerDb = new DatabaseSync(filename);
    const writer = createSqliteAgentRunStore({ db: adapter(writerDb), history: "incremental" });
    await writer.save({ ...state(), toolResults: [result(0)] });
    const before = (await writer.load("run"))!;
    let armed = true;
    const base = adapter(db);
    const reader = createSqliteAgentRunStore({ history: "incremental", db: { ...base, prepare: sql => {
      const stmt = base.prepare!(sql);
      if (sql !== "SELECT state_json FROM zhivex_agent_runs WHERE run_id = ?") return stmt;
      return { ...stmt, get: params => {
        const row = stmt.get(params);
        if (armed) { armed = false; writer.save({ ...before, toolResults: [{ ...result(0), output: { text: "y".repeat(24000) } }] }, { expectedRevision: before.revision }); }
        return row;
      } };
    } } });
    expect(await reader.load("run")).toEqual(before);
    expect((await reader.load("run"))!.toolResults[0]!.output).toEqual({ text: "y".repeat(24000) });
    db.close(); writerDb.close();
  });

  it("hydrates an existing idempotency claim before releasing its transaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-history-claim-")); roots.push(root);
    const filename = join(root, "runs.sqlite");
    const db = new DatabaseSync(filename); db.exec("PRAGMA journal_mode=WAL");
    const writerDb = new DatabaseSync(filename);
    try {
      const writer = createSqliteAgentRunStore({ db: adapter(writerDb), history: "incremental" });
      const initial = { ...state(), idempotencyKey: "claim", toolResults: [result(0)] };
      await writer.save(initial);
      const before = (await writer.load("run"))!;
      const after = { ...before, revision: before.revision! + 1, toolResults: [{ ...result(0), output: { text: "y".repeat(24000) } }] };
      const base = adapter(db);
      let writes = 0;
      const reader = createSqliteAgentRunStore({ history: "incremental", db: {
        ...base,
        exec: sql => {
          base.exec(sql);
          // A second connection can commit as soon as the claim releases its lock.
          if (sql === "COMMIT" && writes++ === 0) writer.save(after, { expectedRevision: before.revision });
        }
      } });
      expect(await reader.claimIdempotencyKey!(initial)).toEqual({ claimed: false, state: before });
      expect(writes).toBe(1);
      expect(await writer.load("run")).toEqual(after);
    } finally {
      db.close(); writerDb.close();
    }
  });

});
