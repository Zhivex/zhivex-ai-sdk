import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { ConflictError } from "@zhivex-ai/core";

import { SandboxError } from "./errors.js";

export interface SandboxLease {
  schemaVersion: 1;
  runId: string;
  scopeKey: string;
  environmentId: string;
  fingerprint: string;
  workspaceId?: string;
  containerId: string;
  networkId?: string;
  snapshotId?: string;
  revision: number;
  status: "active" | "released" | "expired";
  createdAt: number;
  expiresAt: number;
}

export interface SandboxSnapshot {
  schemaVersion: 1;
  id: string;
  runId: string;
  scopeKey: string;
  mode: "workspace-tar" | "docker-commit";
  imageId?: string;
  workspaceTar: Uint8Array;
  createdAt: number;
}

export interface SandboxLeaseStore {
  load(runId: string, scopeKey: string): Promise<SandboxLease | undefined>;
  compareAndSwap(lease: SandboxLease, expectedRevision: number | undefined): Promise<SandboxLease>;
  list(): Promise<SandboxLease[]>;
}

export interface SandboxSnapshotStore {
  load(runId: string, scopeKey: string): Promise<SandboxSnapshot | undefined>;
  save(snapshot: SandboxSnapshot): Promise<void>;
  remove(runId: string, scopeKey: string): Promise<void>;
}

const leaseKey = (runId: string, scopeKey: string) => `${scopeKey}\0${runId}`;

const assertLeaseIdentity = (lease: SandboxLease, runId: string, scopeKey: string) => {
  if (lease.runId !== runId || lease.scopeKey !== scopeKey) {
    throw new SandboxError("STORE_INVALID", "Sandbox lease identity does not match the requested run.");
  }
};

const assertSnapshotIdentity = (snapshot: { runId: string; scopeKey: string }, runId: string, scopeKey: string) => {
  if (snapshot.runId !== runId || snapshot.scopeKey !== scopeKey) {
    throw new SandboxError("SNAPSHOT_INVALID", "Sandbox snapshot identity does not match the requested run.");
  }
};

export const createMemorySandboxLeaseStore = (): SandboxLeaseStore => {
  const records = new Map<string, SandboxLease>();
  return {
    async load(runId, scopeKey) {
      assertStoreRunId(runId);
      assertScopeKey(scopeKey);
      const record = records.get(leaseKey(runId, scopeKey));
      if (!record) return undefined;
      assertLeaseIdentity(record, runId, scopeKey);
      return structuredClone(record);
    },
    async compareAndSwap(lease, expectedRevision) {
      assertStoreRunId(lease.runId);
      assertScopeKey(lease.scopeKey);
      assertLeaseIdentity(lease, lease.runId, lease.scopeKey);
      const key = leaseKey(lease.runId, lease.scopeKey);
      const current = records.get(key);
      if (current?.revision !== expectedRevision) {
        throw new ConflictError(`Sandbox lease for run "${lease.runId}" changed before it could be saved.`);
      }
      records.set(key, structuredClone(lease));
      return structuredClone(lease);
    },
    async list() {
      return [...records.values()].map(record => structuredClone(record));
    }
  };
};

export const createMemorySandboxSnapshotStore = (): SandboxSnapshotStore => {
  const records = new Map<string, SandboxSnapshot>();
  return {
    async load(runId, scopeKey) {
      assertStoreRunId(runId);
      assertScopeKey(scopeKey);
      const record = records.get(leaseKey(runId, scopeKey));
      if (!record) return undefined;
      assertSnapshotIdentity(record, runId, scopeKey);
      return { ...record, workspaceTar: new Uint8Array(record.workspaceTar) };
    },
    async save(snapshot) {
      assertStoreRunId(snapshot.runId);
      assertScopeKey(snapshot.scopeKey);
      assertSnapshotIdentity(snapshot, snapshot.runId, snapshot.scopeKey);
      records.set(leaseKey(snapshot.runId, snapshot.scopeKey), {
        ...snapshot,
        workspaceTar: new Uint8Array(snapshot.workspaceTar)
      });
    },
    async remove(runId, scopeKey) {
      assertStoreRunId(runId);
      assertScopeKey(scopeKey);
      records.delete(leaseKey(runId, scopeKey));
    }
  };
};

const scopeDirectory = (scopeKey: string) => createHash("sha256").update(scopeKey).digest("hex");

/** Reject dot segments before they reach path.join. encodeURIComponent leaves "." and ".." unchanged. */
const assertStoreRunId = (runId: string) => {
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 512 || runId.includes("\0")) {
    throw new SandboxError("STORE_ID", "Sandbox run id must be a non-empty string.");
  }
  if (runId === "." || runId === "..") {
    throw new SandboxError("STORE_ID", "Sandbox run id cannot be '.' or '..'.");
  }
  const encoded = encodeURIComponent(runId);
  if (encoded === "." || encoded === ".." || encoded.includes("/") || encoded.includes("\\")) {
    throw new SandboxError("STORE_ID", "Sandbox run id cannot escape its scope directory.");
  }
  return encoded;
};

const assertScopeKey = (scopeKey: string) => {
  if (typeof scopeKey !== "string" || scopeKey.length === 0 || scopeKey.length > 4096 || scopeKey.includes("\0")) {
    throw new SandboxError("STORE_ID", "Sandbox scope key must be a non-empty string.");
  }
};

/** Join a scope file and refuse a normalized path that leaves the scope directory. */
const scopeFile = (directory: string, scopeKey: string, name: string) => {
  assertScopeKey(scopeKey);
  const scopeDir = path.resolve(directory, scopeDirectory(scopeKey));
  const resolved = path.resolve(scopeDir, name);
  const relative = path.relative(scopeDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SandboxError("STORE_ID", "Sandbox store path escapes its scope directory.");
  }
  return resolved;
};

const assertPrivateFile = async (file: string) => {
  const info = await stat(file);
  if ((info.mode & 0o777) !== 0o600) {
    throw new SandboxError("STORE_PERMISSIONS", `Sandbox state file ${file} must be mode 0600.`);
  }
};

const writePrivate = async (file: string, bytes: Uint8Array | string) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, file);
  await assertPrivateFile(file);
};

const LOCK_WAIT_MS = 5_000;
const MALFORMED_LOCK_MS = 30_000;
const chains = new Map<string, Promise<void>>();

interface FileLockRecord {
  ownerId: string;
  pid: number;
  createdAt: number;
}

const withInProcessLock = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  chains.set(key, tail);
  try {
    await previous;
    return await operation();
  } finally {
    release();
    if (chains.get(key) === tail) chains.delete(key);
  }
};

const processAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const readLock = async (lockPath: string): Promise<{ record?: FileLockRecord; modifiedAt: number } | undefined> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    const body = await handle.readFile({ encoding: "utf8" });
    let record: FileLockRecord | undefined;
    try {
      const parsed = JSON.parse(body) as Partial<FileLockRecord>;
      if (
        typeof parsed.ownerId === "string" &&
        parsed.ownerId.length > 0 &&
        typeof parsed.pid === "number" &&
        Number.isInteger(parsed.pid) &&
        typeof parsed.createdAt === "number"
      ) {
        record = { ownerId: parsed.ownerId, pid: parsed.pid, createdAt: parsed.createdAt };
      }
    } catch {
      record = undefined;
    }
    return { record, modifiedAt: info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
};

const stealLock = async (lockPath: string, current: { record?: FileLockRecord }) => {
  const recovery = `${lockPath}.${randomUUID()}.recovery`;
  try {
    await link(lockPath, recovery);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "EEXIST") return false;
    throw error;
  }
  try {
    const [lockInfo, recoveryInfo] = await Promise.all([lstat(lockPath), lstat(recovery)]);
    if (lockInfo.dev !== recoveryInfo.dev || lockInfo.ino !== recoveryInfo.ino) return false;
    const verified = await readLock(lockPath);
    if (current.record?.ownerId !== verified?.record?.ownerId) return false;
    if (!current.record && verified?.record) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  } finally {
    await unlink(recovery).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};

const acquireFileLock = async (lockPath: string): Promise<() => Promise<void>> => {
  const ownerId = randomUUID();
  const startedAt = Date.now();
  const body = JSON.stringify({ ownerId, pid: process.pid, createdAt: startedAt });
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  while (Date.now() - startedAt <= LOCK_WAIT_MS) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(body);
      await handle.close();
      handle = undefined;
      return async () => {
        const current = await readLock(lockPath);
        if (current?.record?.ownerId !== ownerId) return;
        await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await handle?.close();
    }
    const current = await readLock(lockPath);
    if (!current) continue;
    const deadOwner = current.record ? !processAlive(current.record.pid) : false;
    const malformedStale = !current.record && Date.now() - current.modifiedAt >= MALFORMED_LOCK_MS;
    if ((deadOwner || malformedStale) && await stealLock(lockPath, current)) continue;
    if (Date.now() - startedAt >= LOCK_WAIT_MS) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new ConflictError("Timed out acquiring the sandbox file lock.");
};

const withFileLock = <T>(lockPath: string, operation: () => Promise<T>) =>
  withInProcessLock(lockPath, async () => {
    const release = await acquireFileLock(lockPath);
    try {
      return await operation();
    } finally {
      await release();
    }
  });

const readLeaseFile = async (file: string): Promise<SandboxLease | undefined> => {
  try {
    await assertPrivateFile(file);
    return JSON.parse(await readFile(file, "utf8")) as SandboxLease;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

export const createFileSandboxLeaseStore = (directory: string): SandboxLeaseStore => {
  const fileFor = (runId: string, scopeKey: string) =>
    scopeFile(directory, scopeKey, `${assertStoreRunId(runId)}.json`);
  return {
    async load(runId, scopeKey) {
      try {
        const file = fileFor(runId, scopeKey);
        await assertPrivateFile(file);
        const lease = JSON.parse(await readFile(file, "utf8")) as SandboxLease;
        assertLeaseIdentity(lease, runId, scopeKey);
        return lease;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async compareAndSwap(lease, expectedRevision) {
      const file = fileFor(lease.runId, lease.scopeKey);
      return withFileLock(`${file}.lock`, async () => {
        const current = await readLeaseFile(file);
        if (current && (current.runId !== lease.runId || current.scopeKey !== lease.scopeKey)) {
          throw new SandboxError("STORE_INVALID", "Sandbox lease identity does not match the requested run.");
        }
        if (current?.revision !== expectedRevision) {
          throw new ConflictError(`Sandbox lease for run "${lease.runId}" changed before it could be saved.`);
        }
        assertLeaseIdentity(lease, lease.runId, lease.scopeKey);
        await writePrivate(file, JSON.stringify(lease));
        return lease;
      });
    },
    async list() {
      const { readdir } = await import("node:fs/promises");
      const leases: SandboxLease[] = [];
      let scopes: string[] = [];
      try {
        scopes = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      for (const scope of scopes) {
        const files = await readdir(path.join(directory, scope));
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          const full = path.join(directory, scope, file);
          await assertPrivateFile(full);
          const lease = JSON.parse(await readFile(full, "utf8")) as SandboxLease;
          if (`${encodeURIComponent(lease.runId)}.json` !== file) {
            throw new SandboxError("STORE_INVALID", "Sandbox lease file name does not match the stored run id.");
          }
          leases.push(lease);
        }
      }
      return leases;
    }
  };
};

export const createFileSandboxSnapshotStore = (directory: string): SandboxSnapshotStore => {
  const base = (runId: string, scopeKey: string) => scopeFile(directory, scopeKey, assertStoreRunId(runId));
  const readSnapshot = async (stem: string, runId: string, scopeKey: string): Promise<SandboxSnapshot | undefined> => {
    try {
      await assertPrivateFile(`${stem}.json`);
      await assertPrivateFile(`${stem}.tar`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const meta = JSON.parse(await readFile(`${stem}.json`, "utf8")) as Omit<SandboxSnapshot, "workspaceTar"> & { tarSha256?: string };
    const workspaceTar = new Uint8Array(await readFile(`${stem}.tar`));
    if (meta.tarSha256) {
      const actual = createHash("sha256").update(workspaceTar).digest("hex");
      if (actual !== meta.tarSha256) {
        throw new SandboxError("SNAPSHOT_INVALID", "Sandbox snapshot bytes do not match the stored hash.");
      }
    }
    const { tarSha256: _hash, ...snapshot } = meta;
    assertSnapshotIdentity(snapshot, runId, scopeKey);
    return { ...snapshot, workspaceTar };
  };
  return {
    async load(runId, scopeKey) {
      const stem = base(runId, scopeKey);
      return withFileLock(`${stem}.lock`, () => readSnapshot(stem, runId, scopeKey));
    },
    async save(snapshot) {
      assertSnapshotIdentity(snapshot, snapshot.runId, snapshot.scopeKey);
      const stem = base(snapshot.runId, snapshot.scopeKey);
      await withFileLock(`${stem}.lock`, async () => {
        const { workspaceTar, ...meta } = snapshot;
        const tarSha256 = createHash("sha256").update(workspaceTar).digest("hex");
        await writePrivate(`${stem}.tar`, workspaceTar);
        await writePrivate(`${stem}.json`, JSON.stringify({ ...meta, tarSha256 }));
      });
    },
    async remove(runId, scopeKey) {
      const stem = base(runId, scopeKey);
      await withFileLock(`${stem}.lock`, async () => {
        await rm(`${stem}.json`, { force: true });
        await rm(`${stem}.tar`, { force: true });
      });
    }
  };
};
