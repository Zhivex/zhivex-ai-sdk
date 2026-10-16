import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
      const current = await this.load(lease.runId, lease.scopeKey);
      if (current?.revision !== expectedRevision) {
        throw new ConflictError(`Sandbox lease for run "${lease.runId}" changed before it could be saved.`);
      }
      await writePrivate(fileFor(lease.runId, lease.scopeKey), JSON.stringify(lease));
      return lease;
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
  return {
    async load(runId, scopeKey) {
      const stem = base(runId, scopeKey);
      try {
        await assertPrivateFile(`${stem}.json`);
        await assertPrivateFile(`${stem}.tar`);
        const meta = JSON.parse(await readFile(`${stem}.json`, "utf8")) as Omit<SandboxSnapshot, "workspaceTar">;
        return { ...meta, workspaceTar: new Uint8Array(await readFile(`${stem}.tar`)) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async save(snapshot) {
      const stem = base(snapshot.runId, snapshot.scopeKey);
      const { workspaceTar, ...meta } = snapshot;
      await writePrivate(`${stem}.json`, JSON.stringify(meta));
      await writePrivate(`${stem}.tar`, workspaceTar);
    },
    async remove(runId, scopeKey) {
      const stem = base(runId, scopeKey);
      await rm(`${stem}.json`, { force: true });
      await rm(`${stem}.tar`, { force: true });
    }
  };
};
