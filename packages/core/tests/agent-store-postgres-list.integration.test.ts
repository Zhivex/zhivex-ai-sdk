import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAgentRunStore } from "../src/agent-store/postgres.js";
import { legacyScopedKey, listStates, scopedKey } from "../src/agent-store/shared.js";
import type { AgentRunListOptions, AgentRunState, AgentStoreScope, PostgresClientLike } from "../src/types.js";
import { createPostgresIntegrationClient, dropIntegrationTables, integrationTableName, type PostgresIntegrationClient } from "./postgres-integration-client.js";

const url = process.env.ZHIVEX_POSTGRES_INTEGRATION_URL;
if (process.env.ZHIVEX_WORKFLOW_POSTGRES_CERTIFICATION === "1" && !url) {
  throw new Error("ZHIVEX_POSTGRES_INTEGRATION_URL is required for PostgreSQL list certification.");
}

const state = (runId: string, extra: Partial<AgentRunState> = {}): AgentRunState => ({
  schemaVersion: 1, runId, provider: "fixture", modelId: "fixture", status: "completed",
  messages: [], steps: [], toolResults: [], pendingApprovals: [], currentStep: 0,
  maxSteps: 1, outputText: "", updatedAt: 10, ...extra
});

(url ? describe : describe.skip)("bounded PostgreSQL agent listings", () => {
  const table = integrationTableName("agent_page");
  const tables = ["_tool_journal", "_leases", "_parents", "_idempotency", ""].map(suffix => `${table}${suffix}`);
  let db: PostgresIntegrationClient;
  const reads: { sql: string; rows: number }[] = [];
  let client: PostgresClientLike;
  beforeAll(async () => {
    db = createPostgresIntegrationClient(url!);
    client = { async query<TResult extends Record<string, unknown> = Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      const result = await db.query<TResult>(text, params);
      if (/^\s*(?:SELECT|WITH)\b/i.test(text) && /state_json/.test(text)) reads.push({ sql: text, rows: result.rows.length });
      return result;
    } };
    await createPostgresAgentRunStore({ client, tableName: table }).list!();
  });
  beforeEach(async () => {
    for (const name of tables) await db.query(`DELETE FROM ${name}`);
    reads.length = 0;
  });
  afterAll(async () => { if (db) { await dropIntegrationTables(db, tables); await db.close(); } });
  const store = (scope?: AgentStoreScope) => createPostgresAgentRunStore({ client, tableName: table, scope });
  const seed = async (states: AgentRunState[], legacy = false) => {
    const records = states.map(item => ({ key: (legacy ? legacyScopedKey : scopedKey)(item.scope, item.runId), state: item }));
    await db.query(`INSERT INTO ${table} (run_id, state_json, updated_at_ms)
      SELECT item->>'key', item->'state', 999999 FROM jsonb_array_elements($1::jsonb) AS item`, [records]);
  };
  const assertBounded = (limit: number) => {
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.rows).toBeLessThanOrEqual(limit + 1);
      expect(read.sql).toMatch(/\bLIMIT\b/i);
      expect(read.sql).toMatch(/\bORDER BY\b/i);
    }
  };

  it("filters tenant identity and bounds transferred states before hydration", async () => {
    const scope = { tenantId: "target" };
    const own = Array.from({ length: 8 }, (_, index) => state(`own-${index}`, { scope, updatedAt: index }));
    await seed([...own, ...Array.from({ length: 250 }, (_, i) => state(`foreign-${i}`, {
      scope: i % 2 ? { ...scope, userId: "*" } : { tenantId: "foreign" }, updatedAt: 1000 + i,
      outputText: "large foreign state ".repeat(100)
    }))]);
    const page = await store(scope).list!({ limit: 2 });
    expect(page).toEqual(listStates(own, { limit: 2 }));
    assertBounded(2);
  });

  it("paginates canonical and legacy scope ties with the shared UTF-16 order", async () => {
    const scopes = [undefined, { tenantId: "tenant" }, { tenantId: "tenant", userId: "*" },
      { tenantId: "tenant", namespace: "default" }, { tenantId: 't"\\\n😀', userId: "u\t", namespace: "n\t" }];
    const ids = ["z", "a", "A", "é", "\ue000", "😀", 'quote"\\\n'];
    const states = scopes.flatMap(scope => ids.map(runId => state(runId, { scope })));
    // Legacy identities that have colliding physical keys must not coexist. Keep
    // the wildcard/default aliases canonical and use the tenant scope as legacy.
    await seed(states.filter(s => s.scope !== scopes[1]));
    await seed(states.filter(s => s.scope === scopes[1]), true);
    const actual: AgentRunState[] = [];
    let cursor: string | undefined;
    do {
      const page = await store().list!({ limit: 3, cursor });
      expect(page).toEqual(listStates(states, { limit: 3, cursor }));
      actual.push(...page.items); cursor = page.nextCursor;
      expect(actual.length).toBeLessThanOrEqual(states.length);
    } while (cursor);
    expect(actual).toEqual(listStates(states, { limit: 100 }).items);
    assertBounded(3);
    const legacyCursor = Buffer.from(JSON.stringify([10, "z"])).toString("base64url");
    expect(await store().list!({ limit: 2, cursor: legacyCursor })).toEqual(listStates(states, { limit: 2, cursor: legacyCursor }));
    for (const scope of scopes.slice(1)) {
      expect(await store().list!({ limit: 100 }, scope)).toEqual(listStates(states.filter(s => s.scope === scope), { limit: 100 }));
    }
  });

  it("accepts large valid scopes without exceeding PostgreSQL B-tree tuple limits", async () => {
    const long = Array.from({ length: 100 }, (_, i) => createHash("sha256").update(`scope-${i}`).digest("hex")).join("");
    const scope = { tenantId: long, userId: `${long}u`, namespace: `${long}n` };
    const own = state("large", { scope });
    await store(scope).save(own);
    await seed([state("foreign-large", { scope: { ...scope, userId: `${long}other` } })]);
    reads.length = 0;
    const page = await store(scope).list!({ limit: 1 });
    expect(page.items.map(item => item.runId)).toEqual(["large"]);
    assertBounded(1);
    expect(await store(scope).deleteExpired!({ before: 11, limit: 1 })).toBe(1);
    const remaining = await db.query<{ state_json: AgentRunState }>(`SELECT state_json FROM ${table}`);
    expect(remaining.rows.map(row => row.state_json.runId)).toEqual(["foreign-large"]);
  });

  it("applies all filters in SQL while retaining JSON timestamp fallback semantics", async () => {
    const scope = { tenantId: "filtered" };
    const states = [
      state("match", { scope, agentId: "agent", parentRunId: "parent", updatedAt: 15 }),
      state("old", { scope, agentId: "agent", parentRunId: "parent", updatedAt: 5 }),
      state("new", { scope, agentId: "agent", parentRunId: "parent", updatedAt: 25 }),
      state("other-agent", { scope, agentId: "other", parentRunId: "parent", updatedAt: 16 }),
      state("other-parent", { scope, agentId: "agent", parentRunId: "other", updatedAt: 16 }),
      state("running", { scope, agentId: "agent", parentRunId: "parent", status: "running", updatedAt: 16 }),
      state("started-only", { scope, updatedAt: undefined, startedAt: 50 }),
      state("no-time", { scope, updatedAt: undefined })
    ];
    await seed(states);
    const filters: AgentRunListOptions[] = [
      { agentId: "agent", parentRunId: "parent", statuses: ["completed"], updatedAfter: 10, updatedBefore: 20 },
      { updatedBefore: 1 }, { statuses: [] }, { updatedAfter: 15 }, {}
    ];
    for (const options of filters) {
      const input = { ...options, limit: 1 };
      expect(await store(scope).list!(input)).toEqual(listStates(states, input));
    }
    assertBounded(1);
    await expect(store(scope).list!({ cursor: "invalid" })).rejects.toThrow(/cursor/);
    await expect(store(scope).list!({ limit: 0 })).rejects.toThrow(/limit/);
  });

  it("deletes only the bounded expired tenant page, including matching legacy keys", async () => {
    const scope = { tenantId: "retention" };
    const own = [state("legacy", { scope, updatedAt: 2 }), state("canonical", { scope, updatedAt: 3 }), state("later", { scope, updatedAt: 4 })];
    await seed(own.slice(0, 1), true); await seed(own.slice(1));
    const foreign = Array.from({ length: 100 }, (_, i) => state(`foreign-${i}`, { scope: { tenantId: "other" }, updatedAt: 1 }));
    await seed([...foreign, state("active", { scope, status: "running", updatedAt: 1 })]);
    const removed = await store(scope).deleteExpired!({ before: 4, statuses: ["completed"], limit: 1 });
    expect(removed).toBe(1);
    const pageReads = reads.filter(read => /\bLIMIT\b/i.test(read.sql));
    expect(pageReads).toHaveLength(1); expect(pageReads[0]!.rows).toBeLessThanOrEqual(2);
    const remaining = await db.query<{ state_json: AgentRunState }>(`SELECT state_json FROM ${table}`);
    expect(remaining.rows).toHaveLength(103);
    expect(remaining.rows.some(row => row.state_json.runId === "canonical")).toBe(false);
    expect(remaining.rows.filter(row => row.state_json.scope?.tenantId === "other")).toHaveLength(100);
    expect(await store(scope).deleteExpired!({ before: 4, statuses: ["completed"], limit: 1 })).toBe(1);
    expect(await store(scope).load("legacy")).toBeUndefined();
  });
});
