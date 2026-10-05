import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeAgentRunState } from "../agent-state.js";
import { ConflictError, ValidationError } from "../errors.js";
import { ensurePrivateDirectory, writePrivateFile } from "../store-security.js";
import type {
  AgentMemoryContext,
  AgentMemoryStore,
  AgentRunLease,
  AgentRunPage,
  AgentRunState,
  AgentRunStore,
  AgentRunStoreScopeOptions,
  AgentStoreScope,
  AgentToolCallJournalEntry,
  ModelMessage
} from "../types.js";
import {
  resolveScope,
  scopedKey,
  legacyScopedKey,
  matchesRun,
  matchesScope,
  journalKey,
  sameScope,
  assertLeaseOwner,
  assertExpectedRevision,
  nextStoredState,
  listStates,
  validateLeaseOptions,
  assertJournalRevision,
  nextJournalEntry,
  defaultMemoryKey,
  legacyDefaultMemoryKey,
  encodeAgentMemory,
  decodeAgentMemory,
  LEGACY_MEMORY_MIGRATION_MESSAGE,
  defaultMemoryMessages
} from "./shared.js";

const fileNameForAgentStoreKey = (key: string): string => `${encodeURIComponent(key)}.json`;

const fileNameForIdempotencyKey = (key: string): string =>
  `.idempotency-${createHash("sha256").update(key).digest("hex")}.json`;

const FILE_RUN_LOCK_TIMEOUT_MS = 2_000;

const FILE_RUN_LOCK_RETRY_MS = 10;

const FILE_RUN_LOCK_STALE_MS = 30_000;

interface FileRunStoreLock {
  ownerId: string;
  pid: number;
  createdAt: number;
}

const waitForFileRunLock = () => new Promise<void>((resolve) => {
  setTimeout(resolve, FILE_RUN_LOCK_RETRY_MS);
});

const parseFileRunStoreLock = (value: string): FileRunStoreLock | undefined => {
  try {
    const lock = JSON.parse(value) as Partial<FileRunStoreLock>;
    return typeof lock.ownerId === "string" &&
      Number.isSafeInteger(lock.pid) &&
      lock.pid! > 0 &&
      Number.isFinite(lock.createdAt)
      ? lock as FileRunStoreLock
      : undefined;
  } catch {
    return undefined;
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const readFileRunStoreLock = async (
  lockPath: string
): Promise<{ lock?: FileRunStoreLock; modifiedAt: number } | undefined> => {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    return {
      lock: parseFileRunStoreLock(await handle.readFile("utf8")),
      modifiedAt: stats.mtimeMs
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ValidationError("Refusing to follow a file AgentRunStore lock symlink.");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const removeFileRunStoreLock = async (lockPath: string, ownerId: string): Promise<boolean> => {
  const current = await readFileRunStoreLock(lockPath);
  if (current?.lock?.ownerId !== ownerId) {
    return false;
  }
  try {
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const recoverFileRunStoreLock = async (lockPath: string): Promise<boolean> => {
  const current = await readFileRunStoreLock(lockPath);
  if (!current) {
    return true;
  }
  const malformedAndStale = !current.lock && Date.now() - current.modifiedAt >= FILE_RUN_LOCK_STALE_MS;
  const ownerExited = current.lock ? !isProcessAlive(current.lock.pid) : false;
  // Never steal an old lock from a live owner: a large local store can make a
  // legitimate CAS operation exceed the stale threshold. The age fallback is
  // reserved for malformed locks that have no verifiable owner.
  if (!malformedAndStale && !ownerExited) {
    return false;
  }
  const recoveryId = createHash("sha256")
    .update(current.lock?.ownerId ?? "malformed")
    .digest("hex");
  const recoveryPath = `${lockPath}.${recoveryId}.recovery`;
  try {
    await fs.link(lockPath, recoveryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }

  try {
    const [lockStats, recoveryStats] = await Promise.all([
      fs.lstat(lockPath),
      fs.lstat(recoveryPath)
    ]);
    if (lockStats.dev !== recoveryStats.dev || lockStats.ino !== recoveryStats.ino) {
      return false;
    }
    const verified = await readFileRunStoreLock(lockPath);
    if (
      current.lock?.ownerId !== verified?.lock?.ownerId ||
      (!current.lock && verified?.lock)
    ) {
      return false;
    }
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  } finally {
    await fs.unlink(recoveryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};

const acquireFileRunStoreLock = async (lockPath: string): Promise<() => Promise<void>> => {
  const ownerId = randomUUID();
  const startedAt = Date.now();
  const lock: FileRunStoreLock = { ownerId, pid: process.pid, createdAt: startedAt };
  while (true) {
    try {
      await writePrivateFile(lockPath, JSON.stringify(lock), { flag: "wx" });
      return async () => {
        await removeFileRunStoreLock(lockPath, ownerId);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    if (await recoverFileRunStoreLock(lockPath)) {
      continue;
    }
    if (Date.now() - startedAt >= FILE_RUN_LOCK_TIMEOUT_MS) {
      throw new ConflictError("Timed out acquiring the file AgentRunStore revision lock.");
    }
    await waitForFileRunLock();
  }
};

export const createFileAgentRunStore = (options: AgentRunStoreScopeOptions & {
  directory: string;
}): AgentRunStore => {
  const effectiveScope = (scope?: AgentStoreScope) => resolveScope(options.scope, scope);
  // Existing runs retain their verified physical key, including leases and history.
  // New identities always use canonical keys; foreign legacy aliases are ignored.
  const readJson = async <T>(file: string): Promise<T | undefined> => {
    try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const physicalKey = async (runId: string, scope?: AgentStoreScope) => {
    const targetScope = effectiveScope(scope);
    const canonical = scopedKey(targetScope, runId);
    for (const key of [canonical, legacyScopedKey(targetScope, runId)]) {
      const state = await readJson<AgentRunState>(path.join(options.directory, fileNameForAgentStoreKey(key)));
      if (state && matchesRun(state, runId, targetScope)) return key;
      if (state && key === canonical) throw new ConflictError("Canonical agent key is occupied by a different legacy identity; migrate that identity before writing.");
    }
    return canonical;
  };
  const runPath = async (runId: string, scope?: AgentStoreScope) => path.join(options.directory, fileNameForAgentStoreKey(await physicalKey(runId, scope)));
  const idempotencyPath = (key: string, scope?: AgentStoreScope) => path.join(options.directory, fileNameForIdempotencyKey(scopedKey(effectiveScope(scope), key)));
  const leasePath = async (runId: string, scope?: AgentStoreScope) => path.join(options.directory, `.lease-${createHash("sha256").update(await physicalKey(runId, scope)).digest("hex")}.json`);
  const toolPath = async (runId: string, toolCallId: string, scope?: AgentStoreScope) => {
    const targetScope = effectiveScope(scope);
    const canonical = path.join(options.directory, `.tool-${createHash("sha256").update(journalKey(targetScope, runId, toolCallId)).digest("hex")}.json`);
    const legacy = path.join(options.directory, `.tool-${createHash("sha256").update(`${legacyScopedKey(targetScope, runId)}:${toolCallId}`).digest("hex")}.json`);
    for (const file of [canonical, legacy]) {
      const entry = await readJson<AgentToolCallJournalEntry>(file);
      if (entry && matchesRun(entry, runId, targetScope) && entry.toolCallId === toolCallId) return file;
      if (entry && (file === canonical || await physicalKey(runId, scope) === legacyScopedKey(targetScope, runId))) {
        throw new ConflictError("Persisted journal identity cannot be verified; reconcile or migrate the entry before executing the tool.");
      }
    }
    return canonical;
  };
  const revisionLockPath = (runId: string, scope?: AgentStoreScope) => path.join(options.directory, `.run-lock-${createHash("sha256").update(scopedKey(effectiveScope(scope), runId)).digest("hex")}.lock`);
  // Every operation that mutates the idempotency index takes this lock BEFORE
  // the run lock, including claims and deletes, so lock ordering cannot cycle.
  const acquireIndexLock = () => acquireFileRunStoreLock(path.join(options.directory, ".idempotency-index.lock"));

  const load = async (runId: string, scope?: AgentStoreScope): Promise<AgentRunState | undefined> => {
    try {
      const content = await fs.readFile(await runPath(runId, scope), "utf8");
      const state = normalizeAgentRunState(JSON.parse(content) as AgentRunState);
      return matchesRun(state, runId, effectiveScope(scope)) ? state : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };

  const findByIdempotencyKey = async (idempotencyKey: string, scope?: AgentStoreScope): Promise<AgentRunState | undefined> => {
    const targetScope = effectiveScope(scope);
    for (const file of [idempotencyPath(idempotencyKey, scope), path.join(options.directory, fileNameForIdempotencyKey(legacyScopedKey(targetScope, idempotencyKey)))]) {
      const marker = await readJson<AgentRunState>(file);
      if (marker && marker.idempotencyKey === idempotencyKey && matchesScope(marker.scope, targetScope)) {
        const claimed = normalizeAgentRunState(marker);
        return (await load(claimed.runId, scope)) ?? claimed;
      }
      if (marker && file === idempotencyPath(idempotencyKey, scope)) throw new ConflictError("Canonical idempotency key is occupied by a different legacy identity; migrate that index before writing.");
    }

    let entries: string[];
    try {
      entries = await fs.readdir(options.directory);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error);
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.startsWith(".")) {
        continue;
      }
      const content = await fs.readFile(path.join(options.directory, entry), "utf8");
      const state = normalizeAgentRunState(JSON.parse(content) as AgentRunState);
      if (state.idempotencyKey === idempotencyKey && matchesScope(state.scope, targetScope)) {
        return state;
      }
    }

    return undefined;
  };

  return {
    reconciliationFencing: true,
    load,
    findByIdempotencyKey,
    async findByParentRunId(parentRunId, scope) {
      const targetScope = effectiveScope(scope);
      let entries: string[];
      try {
        entries = await fs.readdir(options.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }

      const states: AgentRunState[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json") || entry.startsWith(".")) {
          continue;
        }
        const content = await fs.readFile(path.join(options.directory, entry), "utf8");
        const state = normalizeAgentRunState(JSON.parse(content) as AgentRunState);
        if (state.parentRunId === parentRunId && matchesScope(state.scope, targetScope)) {
          states.push(state);
        }
      }

      return states;
    },
    async claimIdempotencyKey(state) {
      await ensurePrivateDirectory(options.directory);
      const scope = effectiveScope(state.scope);
      const normalized = normalizeAgentRunState({ ...state, ...(scope ? { scope } : {}) });
      const releaseIndex = await acquireIndexLock();
      try {
        const releaseRun = await acquireFileRunStoreLock(revisionLockPath(state.runId, scope));
        try {
          const existing = await findByIdempotencyKey(state.idempotencyKey, scope);
          if (existing) return { claimed: false, state: existing };
          if (await load(normalized.runId, scope)) throw new ConflictError("Agent run identity already exists.");
          await writePrivateFile(idempotencyPath(state.idempotencyKey, scope), JSON.stringify(normalized, null, 2), { flag: "wx" });
          await writePrivateFile(await runPath(normalized.runId, scope), JSON.stringify(normalized, null, 2));
          return { claimed: true, state: normalized };
        } finally { await releaseRun(); }
      } finally { await releaseIndex(); }
    },
    async save(state, saveOptions) {
      await ensurePrivateDirectory(options.directory);
      const scope = effectiveScope(state.scope);
      const releaseIndex = await acquireIndexLock();
      try {
      const releaseLock = await acquireFileRunStoreLock(revisionLockPath(state.runId, scope));
      try {
        if (saveOptions?.leaseOwnerId) assertLeaseOwner(JSON.parse(await fs.readFile(await leasePath(state.runId, scope), "utf8")), saveOptions.leaseOwnerId);
        const current = await load(state.runId, scope);
        assertExpectedRevision(current, saveOptions?.expectedRevision);
        const normalized = nextStoredState(state, saveOptions);
        if (normalized.idempotencyKey) {
          const owner = await findByIdempotencyKey(normalized.idempotencyKey, scope);
          if (owner && owner.runId !== normalized.runId) {
            throw new ConflictError("AgentRunState idempotency key conflict.");
          }
        }
        const stored = { ...normalized, ...(scope ? { scope } : {}) };
        await writePrivateFile(await runPath(normalized.runId, scope), JSON.stringify(stored, null, 2));
        if (normalized.idempotencyKey) {
          await writePrivateFile(idempotencyPath(normalized.idempotencyKey, scope), JSON.stringify(stored, null, 2));
        }
      } finally {
        await releaseLock();
      }
      } finally { await releaseIndex(); }
    },
    async delete(runId, scope) {
      await ensurePrivateDirectory(options.directory);
      const releaseIndex = await acquireIndexLock();
      try {
      const releaseRun = await acquireFileRunStoreLock(revisionLockPath(runId, scope));
      try {
      const current = await load(runId, scope);
      if (!current) return;
      const targetScope = effectiveScope(scope);
      const physicalLeasePath = await leasePath(runId, scope);
      try {
        await fs.unlink(await runPath(runId, scope));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      if (current.idempotencyKey) {
        for (const file of [idempotencyPath(current.idempotencyKey, scope), path.join(options.directory, fileNameForIdempotencyKey(legacyScopedKey(targetScope, current.idempotencyKey)))]) {
          const marker = await readJson<AgentRunState>(file);
          if (marker && matchesRun(marker, runId, targetScope)) await fs.unlink(file);
        }
      }
      await fs.unlink(physicalLeasePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      const entries = await fs.readdir(options.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entryName of entries.filter((name) => name.startsWith(".tool-") && name.endsWith(".json"))) {
        const entryPath = path.join(options.directory, entryName);
        try {
          const journalEntry = JSON.parse(await fs.readFile(entryPath, "utf8")) as AgentToolCallJournalEntry;
          const sameEntryScope = targetScope
            ? Boolean(journalEntry.scope && sameScope(journalEntry.scope, targetScope))
            : journalEntry.scope === undefined;
          if (journalEntry.runId === runId && sameEntryScope) {
            await fs.unlink(entryPath);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      } finally { await releaseRun(); }
      } finally { await releaseIndex(); }
    },
    async list(listOptions, scope) {
      const targetScope = effectiveScope(scope);
      const entries = await fs.readdir(options.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const states: AgentRunState[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
        const state = normalizeAgentRunState(JSON.parse(await fs.readFile(path.join(options.directory, entry), "utf8")) as AgentRunState);
        if (!targetScope || (state.scope && sameScope(state.scope, targetScope))) states.push(state);
      }
      return listStates(states, listOptions);
    },
    async deleteExpired(retention, scope) {
      const page = await this.list?.({ statuses: retention.statuses, updatedBefore: retention.before, limit: retention.limit ?? 1_000 }, scope);
      const items = (page as AgentRunPage).items;
      for (const state of items) await this.delete?.(state.runId, state.scope);
      return items.length;
    },
    async acquireLease(runId, leaseOptions, scope) {
      await ensurePrivateDirectory(options.directory);
      const unlock = await acquireFileRunStoreLock(revisionLockPath(runId, scope));
      try {
        validateLeaseOptions(leaseOptions);
        if (!await load(runId, scope)) return undefined;
        await ensurePrivateDirectory(options.directory);
        const file = await leasePath(runId, scope);
        const now = leaseOptions.now ?? Date.now();
        const lease = { runId, ownerId: leaseOptions.ownerId, expiresAt: now + leaseOptions.ttlMs };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await writePrivateFile(file, JSON.stringify(lease), { flag: "wx" });
            return lease;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const current = JSON.parse(await fs.readFile(file, "utf8")) as AgentRunLease;
            if (current.ownerId === leaseOptions.ownerId) {
              await writePrivateFile(file, JSON.stringify(lease));
              return lease;
            }
            if (current.expiresAt > now) return undefined;
            await fs.unlink(file).catch(() => undefined);
          }
        }
        return undefined;
      } finally {
        await unlock();
      }
    },
    async renewLease(runId, leaseOptions, scope) {
      await ensurePrivateDirectory(options.directory);
      const unlock = await acquireFileRunStoreLock(revisionLockPath(runId, scope));
      try {
        validateLeaseOptions(leaseOptions);
        const file = await leasePath(runId, scope);
        const now = leaseOptions.now ?? Date.now();
        try {
          const current = JSON.parse(await fs.readFile(file, "utf8")) as AgentRunLease;
          if (current.ownerId !== leaseOptions.ownerId || current.expiresAt <= now) return undefined;
          const lease = { runId, ownerId: leaseOptions.ownerId, expiresAt: now + leaseOptions.ttlMs };
          await writePrivateFile(file, JSON.stringify(lease));
          return lease;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      } finally {
        await unlock();
      }
    },
    async releaseLease(runId, ownerId, scope) {
      await ensurePrivateDirectory(options.directory);
      const unlock = await acquireFileRunStoreLock(revisionLockPath(runId, scope));
      try {
        const file = await leasePath(runId, scope);
        try {
          const current = JSON.parse(await fs.readFile(file, "utf8")) as AgentRunLease;
          if (current.ownerId !== ownerId) return false;
          await fs.unlink(file);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      } finally {
        await unlock();
      }
    },
    async loadToolCall(runId, toolCallId, scope) {
      try {
        const entry = JSON.parse(await fs.readFile(await toolPath(runId, toolCallId, scope), "utf8")) as AgentToolCallJournalEntry;
        return matchesRun(entry, runId, effectiveScope(scope)) && entry.toolCallId === toolCallId ? entry : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async loadToolExecution(runId, toolCallId, scope) {
      return this.loadToolCall?.(runId, toolCallId, scope);
    },
    async listToolCalls(runId, scope) {
      const targetScope = effectiveScope(scope);
      const entries = await fs.readdir(options.directory).catch(() => []);
      const results: AgentToolCallJournalEntry[] = [];
      for (const entry of entries) {
        if (!entry.startsWith(".tool-") || !entry.endsWith(".json")) continue;
        const value = JSON.parse(await fs.readFile(path.join(options.directory, entry), "utf8")) as AgentToolCallJournalEntry;
        if (matchesRun(value, runId, targetScope)) results.push(value);
        else if (value.runId === runId) {
          const legacyKey = legacyScopedKey(targetScope, runId);
          const legacyName = `.tool-${createHash("sha256").update(`${legacyKey}:${value.toolCallId}`).digest("hex")}.json`;
          if (entry === legacyName && await physicalKey(runId, scope) === legacyKey) throw new ConflictError("Persisted journal identity cannot be verified; reconcile or migrate before continuing.");
        }
      }
      return results.sort((a, b) => a.updatedAt - b.updatedAt || a.toolCallId.localeCompare(b.toolCallId));
    },
    async saveToolCall(entry, journalOptions) {
      await ensurePrivateDirectory(options.directory);
      const unlock = await acquireFileRunStoreLock(revisionLockPath(entry.runId, entry.scope));
      try {
        if (journalOptions?.leaseOwnerId) assertLeaseOwner(JSON.parse(await fs.readFile(await leasePath(entry.runId, entry.scope), "utf8")), journalOptions.leaseOwnerId);
        const file = await toolPath(entry.runId, entry.toolCallId, entry.scope);
        const current = await this.loadToolCall?.(entry.runId, entry.toolCallId, entry.scope);
        assertJournalRevision(current, journalOptions?.expectedRevision);
        const scope = effectiveScope(entry.scope);
        const next = nextJournalEntry({ ...entry, ...(scope ? { scope } : {}) }, journalOptions);
        await writePrivateFile(file, JSON.stringify(next, null, 2));
        return next;
      } finally {
        await unlock();
      }
    },
    async claimToolExecution(entry) {
      await ensurePrivateDirectory(options.directory);
      const unlock = await acquireFileRunStoreLock(revisionLockPath(entry.runId, entry.scope));
      try {
        await ensurePrivateDirectory(options.directory);
        if (!await load(entry.runId, entry.scope)) throw new ValidationError("Cannot journal a tool call for an unknown run.");
        const existing = await this.loadToolCall?.(entry.runId, entry.toolCallId, entry.scope);
        if (existing) return { claimed: false, entry: existing };
        const scope = effectiveScope(entry.scope);
        const next = nextJournalEntry({ ...entry, ...(scope ? { scope } : {}), status: "running", revision: 0 });
        try {
          await writePrivateFile(
            await toolPath(entry.runId, entry.toolCallId, entry.scope),
            JSON.stringify(next, null, 2),
            { flag: "wx" }
          );
          return { claimed: true, entry: next };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = await this.loadToolCall?.(entry.runId, entry.toolCallId, entry.scope);
          if (!existing) throw new ConflictError("Tool execution claim could not be loaded.");
          return { claimed: false, entry: existing };
        }
      } finally {
        await unlock();
      }
    },
    async completeToolExecution(entry, journalOptions) {
      return this.saveToolCall?.({ ...entry, status: entry.status === "failed" ? "failed" : "completed" }, journalOptions) as Promise<AgentToolCallJournalEntry>;
    }
  };
};

export const createFileAgentMemoryStore = (options: {
  directory: string;
  key?: (context: AgentMemoryContext) => string;
  selectMessages?: (state: AgentRunState) => ModelMessage[];
  scope?: AgentStoreScope;
}): AgentMemoryStore => {
  const keyFor = (context: AgentMemoryContext) => (options.key ?? defaultMemoryKey)({ ...context, scope: resolveScope(options.scope, context.scope) });
  const memoryContext = (context: AgentMemoryContext) => ({ ...context, scope: resolveScope(options.scope, context.scope) });
  const encode = (context: AgentMemoryContext, messages: ModelMessage[]) => options.key ? messages : encodeAgentMemory(memoryContext(context), messages);
  const decode = (context: AgentMemoryContext, value: unknown) => options.key ? value as ModelMessage[] : decodeAgentMemory(memoryContext(context), value);

  const selectMessages = options.selectMessages ?? defaultMemoryMessages;

  const assertMemoryIdentity = async (context: AgentMemoryContext) => {
    if (options.key) return;
    const exists = async (key: string) => {
      try { await fs.access(path.join(options.directory, fileNameForAgentStoreKey(key))); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    };
    if (await exists(keyFor(context))) {
      decode(context, JSON.parse(await fs.readFile(path.join(options.directory, fileNameForAgentStoreKey(keyFor(context))), "utf8")));
      return;
    }
    if (await exists(legacyDefaultMemoryKey(memoryContext(context)))) {
      throw new ValidationError(LEGACY_MEMORY_MIGRATION_MESSAGE);
    }
  };

  return {
    async load(context) {
      await assertMemoryIdentity(context);
      try {
        const file = await fs.readFile(path.join(options.directory, fileNameForAgentStoreKey(keyFor(context))), "utf8");
        return decode(context, JSON.parse(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },
    async save(context) {
      await assertMemoryIdentity(context);
      await ensurePrivateDirectory(options.directory);
      await writePrivateFile(
        path.join(options.directory, fileNameForAgentStoreKey(keyFor(context))),
        JSON.stringify(encode(context, selectMessages(context.state)), null, 2)
      );
    }
  };
};
