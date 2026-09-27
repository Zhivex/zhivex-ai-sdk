import { createHash } from "node:crypto";
import { ValidationError } from "../errors.js";
import type { AgentRunState, SqliteDatabaseLike, SqliteStatementLike } from "../types.js";

const fields = ["steps", "toolResults", "compactions"] as const;
type Field = typeof fields[number];
type Checkpoint = AgentRunState & { checkpointHistory?: { version: 1; hasCompactions: boolean; counts: Record<Field, number> } };

/** Storage projection only. The public state contract remains fully hydrated. */
export const historyCheckpoint = (state: AgentRunState): Checkpoint => ({
  ...state, steps: [], toolResults: [], compactions: [],
  checkpointHistory: { version: 1, hasCompactions: state.compactions !== undefined, counts: {
    steps: state.steps.length, toolResults: state.toolResults.length, compactions: state.compactions?.length ?? 0
  } }
});

/** All writes run inside the run store's CAS transaction. Content is scoped to
 * the run; deleting a run deletes its history and artifacts together. */
export const sqliteHistory = (db: SqliteDatabaseLike, table: string) => {
  const prepare = (sql: string): SqliteStatementLike => {
    const statement = db.prepare?.(sql) ?? db.query?.(sql);
    if (!statement) throw new ValidationError("SQLite history requires statements.");
    return statement;
  };
  db.exec(`CREATE TABLE IF NOT EXISTS ${table}_history (
    run_key TEXT NOT NULL, field TEXT NOT NULL, ordinal INTEGER NOT NULL, entry_json TEXT NOT NULL,
    PRIMARY KEY (run_key, field, ordinal))`);
  db.exec(`CREATE TABLE IF NOT EXISTS ${table}_blobs (
    run_key TEXT NOT NULL, digest TEXT NOT NULL, content TEXT NOT NULL,
    PRIMARY KEY (run_key, digest))`);
  const put = prepare(`INSERT INTO ${table}_history VALUES (?, ?, ?, ?)
    ON CONFLICT(run_key, field, ordinal) DO UPDATE SET entry_json=excluded.entry_json
    WHERE entry_json <> excluded.entry_json`);
  const trim = prepare(`DELETE FROM ${table}_history WHERE run_key=? AND field=? AND ordinal>=?`);
  const read = prepare(`SELECT ordinal, entry_json FROM ${table}_history
    WHERE run_key=? AND field=? AND ordinal>=? ORDER BY ordinal LIMIT ?`);
  const putBlob = prepare(`INSERT INTO ${table}_blobs VALUES (?, ?, ?) ON CONFLICT DO NOTHING`);
  const getBlob = prepare(`SELECT content FROM ${table}_blobs WHERE run_key=? AND digest=?`);
  const deleteHistory = prepare(`DELETE FROM ${table}_history WHERE run_key=?`);
  const deleteBlobs = prepare(`DELETE FROM ${table}_blobs WHERE run_key=?`);
  if (!read.all) throw new ValidationError("SQLite incremental history requires statement.all().");
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  // Paths are stored separately, so tool data cannot impersonate a reference.
  const encode = (key: string, entry: unknown, blobs: Map<string, string>) => {
    const refs: { path: string[]; digest: string }[] = [];
    const visit = (value: unknown, path: string[]): unknown => {
      if (typeof value === "string" && value.length > 16_384) {
        let hash = blobs.get(value);
        if (!hash) {
          const serialized = JSON.stringify(value);
          hash = digest(serialized);
          putBlob.run([key, hash, serialized]);
          blobs.set(value, hash);
        }
        refs.push({ path, digest: hash });
        return null;
      }
      if (Array.isArray(value)) return value.map((item, i) => visit(item, [...path, String(i)]));
      if (value && typeof value === "object") return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, visit(item, [...path, name])])
      );
      return value;
    };
    return JSON.stringify({ value: visit(entry, []), refs });
  };
  const decode = (key: string, serialized: string) => {
    const entry = JSON.parse(serialized) as { value: any; refs: { path: string[]; digest: string }[] };
    for (const ref of entry.refs) {
      const serialized = getBlob.get([key, ref.digest])?.content;
      if (typeof serialized !== "string" || digest(serialized) !== ref.digest) throw new ValidationError("Agent history artifact is missing or corrupt.");
      const content: unknown = JSON.parse(serialized);
      if (typeof content !== "string") throw new ValidationError("Invalid agent history artifact.");
      if (!ref.path.length) { entry.value = content; continue; }
      let target = entry.value;
      for (const name of ref.path.slice(0, -1)) {
        if (!target || !Object.hasOwn(target, name)) throw new ValidationError("Invalid agent history artifact path.");
        target = target[name];
      }
      const name = ref.path.at(-1)!;
      if (!target || !Object.hasOwn(target, name) || target[name] !== null) throw new ValidationError("Invalid agent history artifact path.");
      Object.defineProperty(target, name, { value: content, enumerable: true, configurable: true, writable: true });
    }
    return entry.value;
  };
  const page = (key: string, field: Field, offset: number, limit: number) => {
    if (!fields.includes(field) || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ValidationError("Invalid agent history page.");
    return read.all!([key, field, offset, limit]).map(row => ({
      ordinal: row.ordinal as number, value: decode(key, row.entry_json as string)
    }));
  };
  return {
    save(key: string, state: AgentRunState) {
      const blobs = new Map<string, string>();
      for (const field of fields) {
        const entries = state[field] ?? [];
        const previous = new Map(read.all!([key, field, 0, Number.MAX_SAFE_INTEGER]).map(row => [row.ordinal, row.entry_json]));
        entries.forEach((entry, i) => {
          const encoded = encode(key, entry, blobs);
          if (previous.get(i) !== encoded) put.run([key, field, i, encoded]);
        });
        trim.run([key, field, entries.length]);
      }
      return historyCheckpoint(state);
    },
    hydrate(key: string, state: Checkpoint): AgentRunState {
      const marker = state.checkpointHistory;
      if (!marker) return state;
      if (marker.version !== 1) throw new ValidationError("Unsupported agent history checkpoint.");
      const result = { ...state };
      delete result.checkpointHistory;
      for (const field of fields) {
        const count = marker.counts[field];
        if (!Number.isSafeInteger(count) || count < 0) throw new ValidationError("Invalid agent history count.");
        const entries: any[] = [];
        while (entries.length < count) {
          const rows = page(key, field, entries.length, Math.min(1000, count - entries.length));
          if (!rows.length) throw new ValidationError("Agent history is incomplete.");
          for (const row of rows) {
            if (row.ordinal !== entries.length) throw new ValidationError("Agent history is incomplete.");
            entries.push(row.value);
          }
        }
        (result as any)[field] = entries;
      }
      if (!marker.hasCompactions) delete result.compactions;
      return result;
    },
    page,
    delete(key: string) { deleteHistory.run([key]); deleteBlobs.run([key]); }
  };
};
