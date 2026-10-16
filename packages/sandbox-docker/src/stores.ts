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

export const createMemorySandboxLeaseStore = (): SandboxLeaseStore => {
  const records = new Map<string, SandboxLease>();
  return {
    async load(runId, scopeKey) {
      const record = records.get(leaseKey(runId, scopeKey));
      return record ? structuredClone(record) : undefined;
    },
    async compareAndSwap(lease, expectedRevision) {
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
      const record = records.get(leaseKey(runId, scopeKey));
      return record ? { ...record, workspaceTar: new Uint8Array(record.workspaceTar) } : undefined;
    },
    async save(snapshot) {
      records.set(leaseKey(snapshot.runId, snapshot.scopeKey), {
        ...snapshot,
        workspaceTar: new Uint8Array(snapshot.workspaceTar)
      });
    },
    async remove(runId, scopeKey) {
      records.delete(leaseKey(runId, scopeKey));
    }
  };
};

const scopeDirectory = (scopeKey: string) => createHash("sha256").update(scopeKey).digest("hex");

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
    path.join(directory, scopeDirectory(scopeKey), `${encodeURIComponent(runId)}.json`);
  return {
    async load(runId, scopeKey) {
      try {
        const file = fileFor(runId, scopeKey);
        await assertPrivateFile(file);
        return JSON.parse(await readFile(file, "utf8")) as SandboxLease;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async compareAndSwap(lease, expectedRevision) {
      const file = fileFor(lease.runId, lease.scopeKey);
      return withFileLock(`${file}.lock`, async () => {
        const current = await readLeaseFile(file);
        if (current?.revision !== expectedRevision) {
          throw new ConflictError(`Sandbox lease for run "${lease.runId}" changed before it could be saved.`);
        }
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
          leases.push(JSON.parse(await readFile(full, "utf8")) as SandboxLease);
        }
      }
      return leases;
    }
  };
};

export const createFileSandboxSnapshotStore = (directory: string): SandboxSnapshotStore => {
  const base = (runId: string, scopeKey: string) =>
    path.join(directory, scopeDirectory(scopeKey), encodeURIComponent(runId));
  const readSnapshot = async (stem: string): Promise<SandboxSnapshot | undefined> => {
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
    return { ...snapshot, workspaceTar };
  };
  return {
    async load(runId, scopeKey) {
      const stem = base(runId, scopeKey);
      return withFileLock(`${stem}.lock`, () => readSnapshot(stem));
    },
    async save(snapshot) {
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
