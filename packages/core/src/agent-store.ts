/** Compatibility facade. Backend implementations live in dedicated internal modules. */
export {
  createInMemoryAgentRunStore,
  createInMemoryAgentMemoryStore
} from "./agent-store/memory.js";
export {
  createFileAgentRunStore,
  createFileAgentMemoryStore
} from "./agent-store/file.js";
export {
  createSqliteAgentRunStore,
  createSqliteAgentMemoryStore
} from "./agent-store/sqlite.js";
export {
  createPostgresAgentRunStore,
  createPostgresAgentMemoryStore
} from "./agent-store/postgres.js";
