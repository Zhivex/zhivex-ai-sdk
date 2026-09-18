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
  sameScope,
  assertLeaseOwner,
  assertExpectedRevision,
  nextStoredState,
  listStates,
  validateLeaseOptions,
  assertJournalRevision,
  nextJournalEntry,
  defaultMemoryKey,
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
  const runPath = (runId: string, scope?: AgentStoreScope) => path.join(options.directory, fileNameForAgentStoreKey(scopedKey(effectiveScope(scope), runId)));
  const idempotencyPath = (key: string, scope?: AgentStoreScope) => path.join(options.directory, fileNameForIdempotencyKey(scopedKey(effectiveScope(scope), key)));
  const leasePath = (runId: string, scope?: AgentStoreScope) => path.join(options.directory, `.lease-${createHash("sha256").update(scopedKey(effectiveScope(scope), runId)).digest("hex")}.json`);
  const toolPath = (runId: string, toolCallId: string, scope?: AgentStoreScope) => path.join(options.directory, `.tool-${createHash("sha256").update(`${scopedKey(effectiveScope(scope), runId)}:${toolCallId}`).digest("hex")}.json`);
  const revisionLockPath = (runId: string, scope?: AgentStoreScope) => path.join(options.directory, `.run-lock-${createHash("sha256").update(scopedKey(effectiveScope(scope), runId)).digest("hex")}.lock`);

  const load = async (runId: string, scope?: AgentStoreScope): Promise<AgentRunState | undefined> => {
    try {
      const content = await fs.readFile(runPath(runId, scope), "utf8");
      return normalizeAgentRunState(JSON.parse(content) as AgentRunState);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };

  const findByIdempotencyKey = async (idempotencyKey: string, scope?: AgentStoreScope): Promise<AgentRunState | undefined> => {
    const targetScope = effectiveScope(scope);
    try {
      const marker = await fs.readFile(idempotencyPath(idempotencyKey, scope), "utf8");
      const claimed = normalizeAgentRunState(JSON.parse(marker) as AgentRunState);
      return (await load(claimed.runId, scope)) ?? claimed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
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
      if (state.idempotencyKey === idempotencyKey && (!targetScope || (state.scope && sameScope(state.scope, targetScope)))) {
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
        if (state.parentRunId === parentRunId && (!targetScope || (state.scope && sameScope(state.scope, targetScope)))) {
          states.push(state);
        }
      }

      return states;
    },
    async claimIdempotencyKey(state) {
      await ensurePrivateDirectory(options.directory);
      const scope = effectiveScope(state.scope);
      const normalized = normalizeAgentRunState({ ...state, ...(scope ? { scope } : {}) });
      try {
        await writePrivateFile(
          idempotencyPath(state.idempotencyKey, scope),
          JSON.stringify(normalized, null, 2),
          { flag: "wx" }
        );
        await writePrivateFile(runPath(normalized.runId, scope), JSON.stringify(normalized, null, 2));
        return { claimed: true, state: normalized };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const existing = await findByIdempotencyKey(state.idempotencyKey, scope);
        if (!existing) {
          throw new ConflictError("AgentRunState idempotency claim could not be loaded.");
        }
        return { claimed: false, state: existing };
      }
    },
    async save(state, saveOptions) {
      await ensurePrivateDirectory(options.directory);
      const scope = effectiveScope(state.scope);
      const releaseLock = await acquireFileRunStoreLock(revisionLockPath(state.runId, scope));
      try {
        if (saveOptions?.leaseOwnerId) assertLeaseOwner(JSON.parse(await fs.readFile(leasePath(state.runId, scope), "utf8")), saveOptions.leaseOwnerId);
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
        await writePrivateFile(runPath(normalized.runId, scope), JSON.stringify(stored, null, 2));
        if (normalized.idempotencyKey) {
          await writePrivateFile(idempotencyPath(normalized.idempotencyKey, scope), JSON.stringify(stored, null, 2));
        }
      } finally {
        await releaseLock();
      }
    },
    async delete(runId, scope) {
      const current = await load(runId, scope);
      const targetScope = effectiveScope(scope);
      try {
        await fs.unlink(runPath(runId, scope));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      if (current?.idempotencyKey) {
        try {
          await fs.unlink(idempotencyPath(current.idempotencyKey, scope));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
      await fs.unlink(leasePath(runId, scope)).catch((error: NodeJS.ErrnoException) => {
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
        const file = leasePath(runId, scope);
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
        const file = leasePath(runId, scope);
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
        const file = leasePath(runId, scope);
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
        return JSON.parse(await fs.readFile(toolPath(runId, toolCallId, scope), "utf8")) as AgentToolCallJournalEntry;
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
        if (value.runId === runId && (!targetScope || (value.scope && sameScope(value.scope, targetScope)))) results.push(value);
      }
      return results.sort((a, b) => a.updatedAt - b.updatedAt || a.toolCallId.localeCompare(b.toolCallId));
    },
    async saveToolCall(entry, journalOptions) {
      await ensurePrivateDirectory(options.directory);
      const unlock = await acquireFileRunStoreLock(revisionLockPath(entry.runId, entry.scope));
      try {
        if (journalOptions?.leaseOwnerId) assertLeaseOwner(JSON.parse(await fs.readFile(leasePath(entry.runId, entry.scope), "utf8")), journalOptions.leaseOwnerId);
        const file = toolPath(entry.runId, entry.toolCallId, entry.scope);
        const current = await this.loadToolCall?.(entry.runId, entry.toolCallId, entry.scope);
        assertJournalRevision(current, journalOptions?.expectedRevision);
        const next = nextJournalEntry(entry, journalOptions);
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
        const next = nextJournalEntry({ ...entry, status: "running", revision: 0 });
        try {
          await writePrivateFile(
            toolPath(entry.runId, entry.toolCallId, entry.scope),
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
  const selectMessages = options.selectMessages ?? defaultMemoryMessages;

  return {
    async load(context) {
      try {
        const file = await fs.readFile(path.join(options.directory, fileNameForAgentStoreKey(keyFor(context))), "utf8");
        return JSON.parse(file) as ModelMessage[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },
    async save(context) {
      await ensurePrivateDirectory(options.directory);
      await writePrivateFile(
        path.join(options.directory, fileNameForAgentStoreKey(keyFor(context))),
        JSON.stringify(selectMessages(context.state), null, 2)
      );
    }
  };
};
