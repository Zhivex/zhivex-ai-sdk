import { ValidationError } from "./errors.js";
import type { PostgresClientLike } from "./types.js";

export const POSTGRES_CLIENT_HELP =
  'The "client" option must expose a query(sql, params) method. The SDK expects an app-owned Postgres-compatible client and does not import a database driver. See docs/PRODUCTION.md.';

export const assertPostgresClient = (client: PostgresClientLike): void => {
  if (!client || typeof (client as { query?: unknown }).query !== "function") {
    throw new ValidationError(POSTGRES_CLIENT_HELP);
  }
};
