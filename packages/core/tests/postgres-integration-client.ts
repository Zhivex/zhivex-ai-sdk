import postgres from "postgres";

import type { PostgresClientLike } from "../src/index.js";

export interface PostgresIntegrationClient extends PostgresClientLike {
  close(): Promise<void>;
}

export const createPostgresIntegrationClient = (
  url: string,
  options: { max?: number } = {}
): PostgresIntegrationClient => {
  const sql = postgres(url, { max: options.max ?? 4 });

  return {
    async query<TResult extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = []
    ) {
      const rows = await sql.unsafe(text, [...params] as never[]);
      return { rows: rows as unknown as TResult[] };
    },
    async close() {
      await sql.end({ timeout: 1 });
    }
  };
};

export const integrationTableName = (purpose: string): string => {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  return `zhivex_it_${purpose}_${suffix}`;
};

export const dropIntegrationTables = async (
  client: PostgresClientLike,
  tableNames: string[]
): Promise<void> => {
  for (const tableName of tableNames) {
    if (!/^zhivex_it_[a-z0-9_]+$/.test(tableName)) {
      throw new Error(`Refusing to drop unexpected integration table ${tableName}.`);
    }
    await client.query(`DROP TABLE IF EXISTS ${tableName}`);
  }
};
