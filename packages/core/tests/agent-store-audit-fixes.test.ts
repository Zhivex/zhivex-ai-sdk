import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryAgentRunStore } from "../src/agent-store/memory.js";
import { createFileAgentRunStore } from "../src/agent-store/file.js";
import { createSqliteAgentRunStore } from "../src/agent-store/sqlite.js";
import { createPostgresAgentRunStore } from "../src/agent-store/postgres.js";
import { legacyScopedKey, scopedKey } from "../src/agent-store/shared.js";
import type { AgentRunState, AgentRunStore, AgentStoreScope, AgentToolCallJournalEntry, SqliteDatabaseLike, PostgresClientLike } from "../src/types.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), "agent-store-audit-")); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir; };
const state = (runId: string, extra: Partial<AgentRunState> = {}): AgentRunState => ({ schemaVersion: 1, runId, provider: "fixture", modelId: "fixture", status: "completed", messages: [], steps: [], toolResults: [], pendingApprovals: [], currentStep: 0, maxSteps: 8, outputText: "", updatedAt: 1, ...extra });
const journal = (runId: string, toolCallId: string, scope?: AgentStoreScope): AgentToolCallJournalEntry => ({ runId, toolCallId, toolName: "mutation", idempotencyKey: `${runId}/${toolCallId}`, input: {}, status: "running", revision: 0, updatedAt: 1, ...(scope ? { scope } : {}) });
const adapter = (db: DatabaseSync): SqliteDatabaseLike => ({ exec: sql => db.exec(sql), prepare: (sql: string) => {
  const statement = db.prepare(sql);
  return { run: (parameters: any = []) => statement.run(...parameters), get: (parameters: any = []) => statement.get(...parameters) as any, all: (parameters: any = []) => statement.all(...parameters) as any };
} });
const sqlite = () => { const db = new DatabaseSync(":memory:"); cleanup.push(() => db.close()); return db; };
const stores: Record<string, () => Promise<AgentRunStore> | AgentRunStore> = {
  memory: () => createInMemoryAgentRunStore(),
  file: async () => createFileAgentRunStore({ directory: await directory() }),
  sqlite: () => createSqliteAgentRunStore({ db: adapter(sqlite()) })
};

for (const [name, create] of Object.entries(stores)) describe(`${name} identity and cursor regressions`, () => {
  it("keeps scoped identities and journals separate from legacy-shaped run IDs", async () => {
    const store = await create();
    const scope = { tenantId: "tenant" };
    await store.save(state("default:tenant:*:secret", { outputText: "unscoped" }));
    expect(await store.load("secret", scope)).toBeUndefined();
    await store.save(state("secret", { scope, outputText: "tenant" }));
    await store.save(state("secret", { scope: { ...scope, userId: "*" }, outputText: "literal-user" }));
    await store.save(state("secret", { scope: { ...scope, namespace: "default" }, outputText: "explicit-namespace" }));
    expect((await store.load("secret", scope))?.outputText).toBe("tenant");
    expect((await store.load("secret", { ...scope, userId: "*" }))?.outputText).toBe("literal-user");
    expect((await store.load("secret", { ...scope, namespace: "default" }))?.outputText).toBe("explicit-namespace");
    expect((await store.list!({}, scope)).items.map(item => item.outputText)).toEqual(["tenant"]);
    await store.save(state("parent")); await store.save(state("parent:child"));
    await store.saveToolCall!(journal("parent:child", "tc"));
    expect(await store.loadToolCall!("parent", "child:tc")).toBeUndefined();
    await store.saveToolCall!(journal("parent", "child:tc"));
    expect((await store.listToolCalls!("parent")).map(item => item.runId)).toEqual(["parent"]);
    await store.delete!("parent");
    expect((await store.loadToolCall!("parent:child", "tc"))?.status).toBe("running");
    await store.delete!("secret", { ...scope, userId: "*" });
    expect((await store.load("secret", scope))?.outputText).toBe("tenant");
  });
  it("paginates aggregate scopes with identical run IDs and timestamps", async () => {
    const store = await create();
    const scopes = [undefined, { tenantId: "a" }, { tenantId: "b" }, { tenantId: "a", userId: "*" }];
    for (const scope of scopes) await store.save(state("same", { ...(scope ? { scope } : {}) }));
    const seen: string[] = []; let cursor: string | undefined;
    do {
      const page = await store.list!({ limit: 1, cursor });
      seen.push(...page.items.map(item => scopedKey(item.scope, item.runId)));
      cursor = page.nextCursor;
      if (cursor) expect(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))).toHaveLength(3);
    } while (cursor);
    expect(seen).toEqual(scopes.map(scope => scopedKey(scope, "same")).sort().reverse());
    await store.save(state("older", { updatedAt: 0 }));
    const legacyCursor = Buffer.from(JSON.stringify([1, "same"])).toString("base64url");
    expect((await store.list!({ cursor: legacyCursor })).items.map(item => item.runId)).toEqual(["older"]);
  });
  it("returns each tied timestamp once across cursor pages", async () => {
    const store = await create();
    const ids = ["a", "A", "b", "B", "_", "ä"];
    for (const id of ids) await store.save(state(id));
    const seen: string[] = []; let cursor: string | undefined;
    do {
      const page = await store.list!({ limit: 1, cursor });
      seen.push(...page.items.map(item => item.runId)); cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...ids].sort().reverse());
  });
});

describe("atomic idempotency", () => {
  it("does not mutate state, parent index or key ownership when memory save conflicts", async () => {
    const store = createInMemoryAgentRunStore();
    await store.save(state("owner", { idempotencyKey: "key" }));
    await store.save(state("other", { parentRunId: "parent" }));
    expect(() => store.save(state("other", { parentRunId: "new-parent", idempotencyKey: "key", outputText: "rejected" }))).toThrow("conflict");
    expect((await store.load("other"))?.outputText).toBe("");
    expect((await store.findByParentRunId!("parent")).map(item => item.runId)).toEqual(["other"]);
    expect(await store.findByParentRunId!("new-parent")).toEqual([]);
    await store.delete!("other");
    expect((await store.findByIdempotencyKey!("key"))?.runId).toBe("owner");
  });
  it("serializes file saves and claims across independent store instances", async () => {
    const dir = await directory();
    const instances = Array.from({ length: 8 }, () => createFileAgentRunStore({ directory: dir }));
    const outcomes = await Promise.all(instances.map(async (store, i) => {
      try {
        if (i % 2) return (await store.claimIdempotencyKey!({ ...state(`run-${i}`), idempotencyKey: "shared" })).claimed;
        await store.save(state(`run-${i}`, { idempotencyKey: "shared" })); return true;
      } catch { return false; }
    }));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const owner = await instances[0]!.findByIdempotencyKey!("shared");
    expect(owner).toBeDefined();
    expect((await instances[0]!.list!()).items).toHaveLength(1);
    expect((await readdir(dir)).filter(file => file.endsWith(".lock"))).toEqual([]);
  });
});

describe("verified legacy persistence", () => {
  it("reads and updates legacy file state, journal and lease without exposing their aliases", async () => {
    const dir = await directory(); const scope = { tenantId: "tenant" };
    const old = state("legacy", { scope, idempotencyKey: "old-key" });
    const key = legacyScopedKey(scope, old.runId);
    const path = join(dir, `${encodeURIComponent(key)}.json`);
    await writeFile(path, JSON.stringify(old));
    const entry = journal(old.runId, "tc", scope);
    const journalPath = join(dir, `.tool-${createHash("sha256").update(`${key}:tc`).digest("hex")}.json`);
    await writeFile(journalPath, JSON.stringify(entry));
    const store = createFileAgentRunStore({ directory: dir });
    expect(await store.load(key)).toBeUndefined();
    expect((await store.load(old.runId, scope))?.idempotencyKey).toBe("old-key");
    expect((await store.findByIdempotencyKey!("old-key", scope))?.runId).toBe(old.runId);
    expect(await store.findByIdempotencyKey!("old-key")).toBeUndefined();
    const claim = await store.claimToolExecution!(entry);
    expect(claim.claimed).toBe(false);
    expect(await store.loadToolCall!(key, "tc")).toBeUndefined();
    await store.acquireLease!(old.runId, { ownerId: "worker", ttlMs: 10000 }, scope);
    await store.save({ ...old, outputText: "updated" }, { expectedRevision: 0, leaseOwnerId: "worker" });
    expect(JSON.parse(await readFile(path, "utf8")).outputText).toBe("updated");
    await store.completeToolExecution!({ ...entry, status: "completed", output: "ok" }, { expectedRevision: 0, leaseOwnerId: "worker" });
    expect(JSON.parse(await readFile(journalPath, "utf8")).output).toBe("ok");
    await store.save(state(key, { outputText: "new unscoped identity" }));
    expect((await store.load(key))?.outputText).toBe("new unscoped identity");
    await store.delete!(key);
    expect((await store.load(old.runId, scope))?.outputText).toBe("updated");
    await store.delete!(old.runId, scope);
    expect(await readdir(dir)).toEqual([]);
  });
  it("keeps legacy SQLite checkpoint history, indices and leases on their physical key", async () => {
    const db = sqlite(); const scope = { tenantId: "tenant" };
    const store = createSqliteAgentRunStore({ db: adapter(db), history: "incremental" });
    const old = state("legacy", { scope, idempotencyKey: "old-key", parentRunId: "parent", toolResults: [{ toolCallId: "t", toolName: "t", isError: false, output: "old" }] });
    const key = legacyScopedKey(scope, old.runId);
    db.prepare("INSERT INTO zhivex_agent_runs VALUES (?, ?, ?)").run(key, JSON.stringify(old), 1);
    db.prepare("INSERT INTO zhivex_agent_runs_idempotency VALUES (?, ?, ?)").run(legacyScopedKey(scope, "old-key"), key, 1);
    db.prepare("INSERT INTO zhivex_agent_runs_parents VALUES (?, ?, ?)").run(key, legacyScopedKey(scope, "parent"), 1);
    expect(await store.load(key)).toBeUndefined();
    expect((await store.findByIdempotencyKey!("old-key", scope))?.runId).toBe(old.runId);
    expect((await store.findByParentRunId!("parent", scope)).map(item => item.runId)).toEqual([old.runId]);
    await store.acquireLease!(old.runId, { ownerId: "worker", ttlMs: 10000 }, scope);
    await store.save({ ...old, outputText: "updated" }, { expectedRevision: 0 });
    expect((await store.load(old.runId, scope))?.toolResults).toEqual(old.toolResults);
    expect(await store.loadHistory!(old.runId, { field: "toolResults" }, scope)).toEqual(old.toolResults);
    expect(db.prepare("SELECT run_id FROM zhivex_agent_runs").all()).toEqual([{ run_id: key }]);
    await store.save(state(key)); await store.delete!(key);
    expect((await store.load(old.runId, scope))?.outputText).toBe("updated");
    expect(await store.renewLease!(old.runId, { ownerId: "worker", ttlMs: 10000 }, scope)).toBeDefined();
    await store.delete!(old.runId, scope);
    expect(await store.load(old.runId, scope)).toBeUndefined();
  });
  it("checks exact identities before accepting PostgreSQL legacy query results", async () => {
    const scope = { tenantId: "tenant" }; const old = state("run", { scope });
    const legacy = legacyScopedKey(scope, "run");
    const client: PostgresClientLike = { query: async (sql, parameters) => {
      if (sql.includes("SELECT state_json FROM") && parameters?.[0] === legacy) return { rows: [{ state_json: old }] } as any;
      return { rows: [] };
    } };
    const store = createPostgresAgentRunStore({ client });
    expect(await store.load(legacy)).toBeUndefined();
    expect((await store.load("run", scope))?.runId).toBe("run");
    expect(await store.load("run", { ...scope, userId: "*" })).toBeUndefined();
    expect(scopedKey(scope, "run")).not.toBe(scopedKey(undefined, legacy));
  });
});

describe("agent memory isolation and explicit migration", () => {
  it.each(["memory", "file", "sqlite"])("isolates default and literal wildcard identities in %s memory", async kind => {
    const { createInMemoryAgentMemoryStore, createFileAgentMemoryStore, createSqliteAgentMemoryStore } = await import("../src/agent-store.js");
    const store = kind === "memory" ? createInMemoryAgentMemoryStore() : kind === "file" ? createFileAgentMemoryStore({ directory: await directory() }) : createSqliteAgentMemoryStore({ db: adapter(sqlite()) });
    const contexts = [
      { runId: "r", agentId: "agent", scope: { tenantId: "tenant" } },
      { runId: "r", agentId: "agent", scope: { tenantId: "tenant", userId: "*" } },
      { runId: "r", agentId: "agent", scope: { tenantId: "tenant", namespace: "default" } },
      { runId: "default:tenant:*:agent", agentId: "agent" }
    ];
    for (const [index, context] of contexts.entries()) {
      await store.save!({ ...context, state: state(context.runId, { messages: [{ role: "assistant", parts: [{ type: "text", text: `private-${index}` }] }] }) });
    }
    for (const [index, context] of contexts.entries()) expect(await store.load(context)).toEqual([{ role: "assistant", parts: [{ type: "text", text: `private-${index}` }] }]);
  });
  it.each(["file", "sqlite"])("refuses unverifiable legacy memory in %s until explicitly migrated", async kind => {
    const { createFileAgentMemoryStore, createSqliteAgentMemoryStore } = await import("../src/agent-store.js");
    const context = { runId: "r", agentId: "agent", scope: { tenantId: "tenant" } };
    const messages = [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "legacy secret" }] }];
    const legacyKey = legacyScopedKey(context.scope, context.agentId);
    const dir = await directory(); const db = sqlite();
    const legacyStore = kind === "file" ? createFileAgentMemoryStore({ directory: dir, key: () => legacyKey }) : createSqliteAgentMemoryStore({ db: adapter(db), key: () => legacyKey });
    await legacyStore.save!({ ...context, state: state("r", { messages }) });
    const store = kind === "file" ? createFileAgentMemoryStore({ directory: dir }) : createSqliteAgentMemoryStore({ db: adapter(db) });
    await expect(Promise.resolve().then(() => store.load(context))).rejects.toThrow("Migrate it offline");
    await expect(Promise.resolve().then(() => store.load({ ...context, scope: { ...context.scope, userId: "*" } }))).rejects.toThrow("Migrate it offline");
    await expect(Promise.resolve().then(() => store.save!({ ...context, state: state("r") }))).rejects.toThrow("Migrate it offline");
    expect(await legacyStore.load(context)).toEqual(messages);
  });
  it("does not accept a raw legacy array occupying a canonical memory filename", async () => {
    const { createFileAgentMemoryStore } = await import("../src/agent-store.js");
    const { defaultMemoryKey } = await import("../src/agent-store/shared.js");
    const context = { runId: "r" }; const dir = await directory();
    const file = join(dir, `${encodeURIComponent(defaultMemoryKey(context))}.json`);
    await writeFile(file, JSON.stringify([{ role: "assistant", parts: [{ type: "text", text: "foreign" }] }]));
    const store = createFileAgentMemoryStore({ directory: dir });
    await expect(store.load(context)).rejects.toThrow("no verifiable identity");
    await expect(store.save!({ ...context, state: state("r") })).rejects.toThrow("no verifiable identity");
    expect(await readFile(file, "utf8")).toContain("foreign");
  });
});

describe("indeterminate legacy journal ownership", () => {
  it.each(["file", "sqlite"])("blocks replay when a %s legacy scoped journal lacks its scope", async kind => {
    const scope = { tenantId: "tenant" }; const old = state("run", { scope });
    const key = legacyScopedKey(scope, old.runId); const entry = journal(old.runId, "tc");
    const dir = await directory(); const db = sqlite();
    const store = kind === "file" ? createFileAgentRunStore({ directory: dir }) : createSqliteAgentRunStore({ db: adapter(db) });
    if (kind === "file") {
      await writeFile(join(dir, `${encodeURIComponent(key)}.json`), JSON.stringify(old));
      await writeFile(join(dir, `.tool-${createHash("sha256").update(`${key}:tc`).digest("hex")}.json`), JSON.stringify(entry));
    } else {
      db.prepare("INSERT INTO zhivex_agent_runs VALUES (?, ?, ?)").run(key, JSON.stringify(old), 1);
      db.prepare("INSERT INTO zhivex_agent_runs_tool_journal VALUES (?, ?, ?, ?, ?)").run(key, "tc", JSON.stringify(entry), 0, 1);
    }
    await expect(Promise.resolve().then(() => store.claimToolExecution!({ ...entry, scope }))).rejects.toThrow("identity cannot be verified");
    await expect(Promise.resolve().then(() => store.listToolCalls!(old.runId, scope))).rejects.toThrow("identity cannot be verified");
  });
});


describe("configured SQLite scope and foreign legacy indices", () => {
  it("filters legacy alias owners before incremental hydration and admits the actual scope", async () => {
    const db = sqlite();
    const foreignScope = { tenantId: "tenant" };
    const scope = { tenantId: "tenant", userId: "*" };
    const store = createSqliteAgentRunStore({ db: adapter(db), scope, history: "incremental" });
    const foreign = state("legacy", { scope: foreignScope, idempotencyKey: "key", parentRunId: "parent" });
    const key = legacyScopedKey(foreignScope, foreign.runId);
    db.prepare("INSERT INTO zhivex_agent_runs VALUES (?, ?, ?)").run(key, JSON.stringify(foreign), 1);
    db.prepare("INSERT INTO zhivex_agent_runs_idempotency VALUES (?, ?, ?)").run(legacyScopedKey(foreignScope, "key"), key, 1);
    db.prepare("INSERT INTO zhivex_agent_runs_parents VALUES (?, ?, ?)").run(key, legacyScopedKey(foreignScope, "parent"), 1);
    expect(await store.load("legacy")).toBeUndefined();
    expect(await store.findByIdempotencyKey!("key")).toBeUndefined();
    expect(await store.findByParentRunId!("parent")).toEqual([]);
    const claimed = await store.claimIdempotencyKey!({ ...state("local", { parentRunId: "parent" }), idempotencyKey: "key" });
    expect(claimed.claimed).toBe(true);
    await store.save({ ...claimed.state, outputText: "local-only" });
    expect((await store.findByIdempotencyKey!("key"))?.outputText).toBe("local-only");
    expect((await store.findByParentRunId!("parent")).map(item => item.runId)).toEqual(["local"]);
    expect(JSON.parse(db.prepare("SELECT state_json FROM zhivex_agent_runs WHERE run_id = ?").get(key)!.state_json as string)).toEqual(foreign);
  });
});
