import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

import {
  ConflictError,
  createAgentExecutionEnvironmentBinding,
  type AgentExecutionAuthorizationRequest,
  type AgentExecutionEnvironment,
  type AgentExecutionEnvironmentManifest,
  type AgentExecutionEnvironmentSession,
  type AgentStatus,
  type AgentStoreScope
} from "@zhivex-ai/core";

import type { DockerClient, DockerContainerInspection, DockerCreateSpec, DockerExecResult } from "./docker-client.js";
import { createNodeDockerClient } from "./docker-client.js";
import { SandboxError } from "./errors.js";
import { allowlistProxyQuotaDefaults, normalizeAllowlist, startAllowlistProxy, type AllowlistProxy } from "./network.js";
import { assertRelativeWorkspacePath, assertWorkspaceRoot, commandBaseName, resolveWorkspacePath } from "./paths.js";
import { createMemorySandboxLeaseStore, createMemorySandboxSnapshotStore, type SandboxLease, type SandboxLeaseStore, type SandboxSnapshot, type SandboxSnapshotStore } from "./stores.js";
import { decodeCappedText } from "./stream.js";
import { packTar, stripTarRoot, unpackTar, type TarEntry } from "./tar.js";

const encoder = new TextEncoder();
let sourceBytesRead = 0;

/** Bytes actually read while importing a host source tree. Tests use this to prove early aborts. */
export const sandboxSourceBytesRead = () => sourceBytesRead;

export const dockerSandboxSecurityDefaults = Object.freeze({
  image: "alpine:3.21",
  user: "65534:65534",
  workspaceRoot: "/workspace",
  network: "deny",
  assurance: "enforced",
  isolation: "per-run",
  memoryMb: 256,
  cpus: 0.5,
  pidsLimit: 64,
  maxProcessRuntimeMs: 10_000,
  maxProcessOutputBytes: 1_048_576,
  maxFileBytes: 1_048_576,
  maxWorkspaceBytes: 64 * 1024 * 1024,
  leaseTtlMs: 15 * 60 * 1000,
  readonlyRootfs: true,
  droppedCapabilities: "ALL",
  noNewPrivileges: true,
  snapshot: "workspace-tar",
  shell: "deny",
  inheritedEnvironment: [] as readonly string[],
  followSymlinks: false,
  undeclaredTools: "deny",
  localUnixFallback: false
});

export interface DockerSandboxWorkspaceFile {
  path: string;
  contents: string | Uint8Array;
  mode?: number;
}

export interface DockerSandboxOptions {
  id?: string;
  version?: string;
  image?: string;
  /** Numeric non-root `uid:gid`. Root is rejected. */
  user?: string;
  docker?: DockerClient;
  socketPath?: string;
  assurance?: "best-effort" | "enforced";
  workspace: {
    id: string;
    root?: string;
    access?: "read-only" | "read-write";
    files?: DockerSandboxWorkspaceFile[];
    directories?: string[];
    source?: { root: string; include: string[] };
  };
  shell?: "deny" | "allow" | { allow: string[] };
  network?: { mode: "deny" } | {
    mode: "allowlist";
    allowedDomains: string[];
    allowedPorts: number[];
    allowPrivateNetworks?: boolean;
  };
  /** Names of in-process tools that may run beside the sandbox tools. They are not jailed. */
  undeclaredTools?: "allow" | "deny";
  environment?: Record<string, string>;
  inheritedVariables?: string[];
  limits?: {
    memoryMb?: number;
    cpus?: number;
    pidsLimit?: number;
    maxProcessRuntimeMs?: number;
    maxProcessOutputBytes?: number;
    maxFileBytes?: number;
    maxWorkspaceBytes?: number;
    maxConcurrentProcesses?: number;
  };
  leaseTtlMs?: number;
  leases?: SandboxLeaseStore;
  snapshots?: SandboxSnapshotStore;
  snapshot?: "workspace-tar" | "docker-commit";
  /** Stable id for containers this environment is allowed to sweep. Defaults to a random per-instance id. */
  ownerId?: string;
  clock?: () => number;
}

export interface DockerSandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface DockerSandboxSession extends AgentExecutionEnvironmentSession {
  readonly kind: "docker-sandbox";
  readonly containerId: string;
  readFile(filePath: string): Promise<Uint8Array>;
  writeFile(filePath: string, contents: Uint8Array | string): Promise<void>;
  list(filePath?: string): Promise<string[]>;
  exec(argv: readonly string[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<DockerSandboxExecResult>;
  snapshot(): Promise<{ id: string; mode: "workspace-tar" | "docker-commit"; imageId?: string }>;
}

export interface DockerSandboxEnvironment extends AgentExecutionEnvironment {
  sweep(now?: number): Promise<{ removedContainerIds: string[] }>;
}

interface ResolvedLimits {
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  maxProcessRuntimeMs: number;
  maxProcessOutputBytes: number;
  maxFileBytes: number;
  maxWorkspaceBytes: number;
  maxConcurrentProcesses: number;
}

interface ShellPolicy {
  mode: "deny" | "allow" | "allowlist";
  commands: string[];
}

const terminalStatus = new Set<AgentStatus>(["completed", "failed", "cancelled", "timed_out"]);

const scopeKeyOf = (scope: AgentStoreScope | undefined) =>
  JSON.stringify([scope?.tenantId ?? "", scope?.userId ?? "", scope?.namespace ?? ""]);

const integerLimit = (value: number | undefined, fallback: number, name: string, max: number) => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) {
    throw new SandboxError("LIMIT", `${name} must be an integer from 1 to ${max}.`);
  }
  return resolved;
};

const parseUser = (user: string) => {
  const match = /^([1-9]\d*):([1-9]\d*)$/.exec(user);
  const uid = Number(match?.[1]);
  const gid = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) {
    throw new SandboxError("USER", "Sandbox user must be a non-root numeric uid:gid, for example 65534:65534.");
  }
  return { user, uid, gid };
};

const parseShell = (shell: DockerSandboxOptions["shell"]): ShellPolicy => {
  if (shell === undefined || shell === "deny") return { mode: "deny", commands: [] };
  if (shell === "allow") return { mode: "allow", commands: [] };
  const commands = [...new Set(shell.allow.map(commandBaseName))].sort();
  if (commands.length === 0) {
    throw new SandboxError("SHELL_ALLOWLIST_EMPTY", "Shell allowlist requires at least one command name.");
  }
  return { mode: "allowlist", commands };
};

const parseEnvironment = (environment: Record<string, string> | undefined, inherited: readonly string[]) => {
  const names = [...new Set(inherited)].sort();
  const entries: string[] = [];
  for (const name of names) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new SandboxError("ENVIRONMENT", `Inherited variable "${name}" is not an uppercase environment name.`);
    }
    const value = environment?.[name];
    if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\0\r\n]/.test(value)) {
      throw new SandboxError("ENVIRONMENT", `Inherited variable "${name}" must be an explicit single-line value.`);
    }
    entries.push(`${name}=${value}`);
  }
  return { names, entries };
};

const validateArgv = (argv: unknown, shell: ShellPolicy): string[] => {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64) {
    throw new SandboxError("COMMAND_INVALID", "Sandbox commands must be an argv array of 1 to 64 strings.");
  }
  if (shell.mode === "deny") {
    throw new SandboxError("SHELL_DENIED", "Shell execution is disabled for this sandbox.");
  }
  const command = argv.map(part => {
    if (typeof part !== "string" || part.length === 0 || part.length > 4096 || part.includes("\0")) {
      throw new SandboxError("COMMAND_INVALID", "Sandbox command arguments must be non-empty strings without NUL bytes.");
    }
    return part;
  });
  const name = commandBaseName(command[0] ?? "");
  if (shell.mode === "allowlist" && !shell.commands.includes(name)) {
    throw new SandboxError("SHELL_DENIED", `Command "${name}" is not on the sandbox allowlist.`);
  }
  return command;
};

export const createDockerSandboxEnvironment = (options: DockerSandboxOptions): DockerSandboxEnvironment => {
  const docker = options.docker ?? createNodeDockerClient({ socketPath: options.socketPath });
  const user = parseUser(options.user ?? dockerSandboxSecurityDefaults.user);
  const image = options.image ?? dockerSandboxSecurityDefaults.image;
  if (!image.trim() || /\s/.test(image)) {
    throw new SandboxError("IMAGE", "Sandbox image must be a non-empty image reference without whitespace.");
  }
  const access = options.workspace.access ?? "read-write";
  const shell = parseShell(options.shell);
  if (access === "read-only" && shell.mode !== "deny") {
    throw new SandboxError(
      "READ_ONLY_SHELL",
      "A read-only workspace cannot enable shell execution. The reference profile cannot remount the workspace after seeding."
    );
  }
  const network = options.network ?? { mode: "deny" as const };
  const allowlist = network.mode === "allowlist" ? normalizeAllowlist(network) : undefined;
  const environment = parseEnvironment(options.environment, options.inheritedVariables ?? []);
  const limits: ResolvedLimits = {
    memoryBytes: integerLimit(options.limits?.memoryMb, dockerSandboxSecurityDefaults.memoryMb, "memoryMb", 8192) * 1024 * 1024,
    nanoCpus: Math.round((() => {
      const cpus = options.limits?.cpus ?? dockerSandboxSecurityDefaults.cpus;
      if (!(cpus > 0) || cpus > 16) throw new SandboxError("LIMIT", "cpus must be greater than 0 and at most 16.");
      return cpus;
    })() * 1_000_000_000),
    pidsLimit: integerLimit(options.limits?.pidsLimit, dockerSandboxSecurityDefaults.pidsLimit, "pidsLimit", 1024),
    maxProcessRuntimeMs: integerLimit(options.limits?.maxProcessRuntimeMs, dockerSandboxSecurityDefaults.maxProcessRuntimeMs, "maxProcessRuntimeMs", 3_600_000),
    maxProcessOutputBytes: integerLimit(options.limits?.maxProcessOutputBytes, dockerSandboxSecurityDefaults.maxProcessOutputBytes, "maxProcessOutputBytes", 8_388_608),
    maxFileBytes: integerLimit(options.limits?.maxFileBytes, dockerSandboxSecurityDefaults.maxFileBytes, "maxFileBytes", 8_388_608),
    maxWorkspaceBytes: integerLimit(options.limits?.maxWorkspaceBytes, dockerSandboxSecurityDefaults.maxWorkspaceBytes, "maxWorkspaceBytes", 1_073_741_824),
    maxConcurrentProcesses: integerLimit(options.limits?.maxConcurrentProcesses, 1, "maxConcurrentProcesses", 8)
  };
  const assurance = options.assurance ?? (docker.kind === "memory" ? "best-effort" : "enforced");
  if (assurance === "enforced" && docker.kind !== "node") {
    throw new SandboxError("UNENFORCED_DOUBLE", "The in-memory Docker client cannot satisfy assurance: enforced.");
  }
  const workspaceRoot = assertWorkspaceRoot(options.workspace.root ?? dockerSandboxSecurityDefaults.workspaceRoot);
  const declaredPaths = [
    ...(options.workspace.files ?? []).map(file => assertRelativeWorkspacePath(file.path)),
    ...(options.workspace.directories ?? []).map(assertRelativeWorkspacePath),
    ...(options.workspace.source?.include ?? []).map(assertRelativeWorkspacePath)
  ].sort();
  const snapshotMode = options.snapshot ?? "workspace-tar";
  const undeclaredTools = options.undeclaredTools ?? "deny";
  const ownerId = options.ownerId ?? randomUUID();
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(ownerId)) {
    throw new SandboxError("OWNER", "Sandbox owner id must be 8-128 characters of letters, digits, and . _ : -.");
  }
  const networkQuotas = allowlist ? allowlistProxyQuotaDefaults : undefined;
  const manifest: AgentExecutionEnvironmentManifest = {
    schemaVersion: 1,
    id: options.id ?? "docker-sandbox",
    version: options.version ?? "1",
    backend: "container",
    assurance,
    isolation: "per-run",
    workspace: {
      id: options.workspace.id,
      root: workspaceRoot,
      cwd: workspaceRoot,
      access,
      followSymlinks: false
    },
    permissions: {
      undeclaredTools,
      filesystem: access === "read-only" ? "read-only" : "read-write",
      network: allowlist
        ? {
            mode: "allowlist",
            allowedDomains: allowlist.domains,
            allowedPorts: allowlist.ports,
            allowPrivateNetworks: network.mode === "allowlist" && network.allowPrivateNetworks === true
          }
        : { mode: "deny" },
      process: shell.mode === "allowlist"
        ? { shell: "allowlist", allowedCommands: shell.commands }
        : { shell: shell.mode },
      environment: { inheritedVariables: environment.names }
    },
    limits: {
      maxProcessRuntimeMs: limits.maxProcessRuntimeMs,
      maxProcessOutputBytes: limits.maxProcessOutputBytes,
      maxConcurrentProcesses: limits.maxConcurrentProcesses,
      maxMemoryMb: limits.memoryBytes / (1024 * 1024),
      maxWorkspaceBytes: limits.maxWorkspaceBytes,
      maxFileWriteBytes: limits.maxFileBytes,
      ...(networkQuotas
        ? { maxNetworkRequests: networkQuotas.maxRequests, maxNetworkBytes: networkQuotas.maxBytes }
        : {})
    },
    metadata: {
      sandbox: "docker",
      image,
      user: user.user,
      nanoCpus: limits.nanoCpus,
      pidsLimit: limits.pidsLimit,
      snapshot: snapshotMode,
      declaredPaths,
      ...(networkQuotas ? { networkQuotas } : {})
    }
  };
  const workspaceId = manifest.workspace?.id;
  if (!workspaceId?.trim()) {
    throw new SandboxError("WORKSPACE_ID", "Sandbox workspace id must be a non-empty string.");
  }
  const binding = createAgentExecutionEnvironmentBinding(manifest);
  const leases = options.leases ?? createMemorySandboxLeaseStore();
  const snapshots = options.snapshots ?? createMemorySandboxSnapshotStore();
  const ttl = integerLimit(options.leaseTtlMs, dockerSandboxSecurityDefaults.leaseTtlMs, "leaseTtlMs", 86_400_000);
  const clock = options.clock ?? Date.now;
  const proxies = new Map<string, { proxy: AllowlistProxy; networkId: string; gateway: string }>();
  const proxyKey = (runId: string, scopeKey: string) => `${scopeKey}\0${runId}`;

  const seedEntries = async (signal?: AbortSignal): Promise<TarEntry[]> => {
    const budget = { remaining: limits.maxWorkspaceBytes };
    const claim = (bytes: Uint8Array, label: string) => {
      if (bytes.byteLength > limits.maxFileBytes) {
        throw new SandboxError("LIMIT", `Sandbox file ${label} exceeds maxFileBytes.`);
      }
      if (bytes.byteLength > budget.remaining) {
        throw new SandboxError("LIMIT", "Declared workspace files exceed maxWorkspaceBytes.");
      }
      budget.remaining -= bytes.byteLength;
      return bytes;
    };
    const entries: TarEntry[] = [];
    for (const directory of options.workspace.directories ?? []) {
      throwIfSourceAborted(signal);
      entries.push({ path: assertRelativeWorkspacePath(directory), type: "directory", mode: 0o755, uid: user.uid, gid: user.gid });
    }
    for (const file of options.workspace.files ?? []) {
      throwIfSourceAborted(signal);
      const content = typeof file.contents === "string" ? encoder.encode(file.contents) : file.contents;
      entries.push({
        path: assertRelativeWorkspacePath(file.path),
        type: "file",
        content: claim(content, file.path),
        mode: file.mode ?? 0o644,
        uid: user.uid,
        gid: user.gid
      });
    }
    if (options.workspace.source) {
      entries.push(...await readSourceTree(
        options.workspace.source.root,
        options.workspace.source.include,
        limits,
        user.uid,
        user.gid,
        budget,
        signal
      ));
    }
    const total = entries.reduce((sum, entry) => sum + (entry.content?.byteLength ?? 0), 0);
    if (total > limits.maxWorkspaceBytes) {
      throw new SandboxError("LIMIT", "Declared workspace files exceed maxWorkspaceBytes.");
    }
    return entries;
  };

  const baseEnv = () => [
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME=/tmp",
    "TMPDIR=/tmp",
    ...environment.entries
  ];

  const openNetwork = async (runId: string, scopeKey: string) => {
    if (!allowlist || network.mode !== "allowlist") return undefined;
    const key = proxyKey(runId, scopeKey);
    const existing = proxies.get(key);
    if (existing) return existing;
    const created = await docker.createNetwork(`zhivex_${randomUUID()}`);
    const gateway = created.gateway;
    const listenHost = docker.kind === "memory" ? "127.0.0.1" : gateway;
    if (!listenHost) {
      await docker.removeNetwork(created.Id).catch(() => undefined);
      throw new SandboxError("NETWORK_PROXY", "Allowlist network did not publish a gateway address. Refusing to attach a routed network.");
    }
    try {
      const proxy = await startAllowlistProxy({
        host: listenHost,
        quotas: allowlistProxyQuotaDefaults,
        policy: {
          allowedDomains: allowlist.domains,
          allowedPorts: allowlist.ports,
          allowPrivateNetworks: network.allowPrivateNetworks === true
        }
      });
      const opened = { proxy, networkId: created.Id, gateway: gateway ?? listenHost };
      proxies.set(key, opened);
      return opened;
    } catch (error) {
      await docker.removeNetwork(created.Id).catch(() => undefined);
      throw error;
    }
  };

  const specFor = (runId: string, networkMode: string, proxyUrl?: string): DockerCreateSpec => ({
    image,
    user: user.user,
    workingDir: workspaceRoot,
    env: proxyUrl ? [...baseEnv(), `HTTP_PROXY=${proxyUrl}`, `HTTPS_PROXY=${proxyUrl}`, "NO_PROXY=localhost,127.0.0.1"] : baseEnv(),
    cmd: ["/bin/sh", "-c", "while true; do sleep 3600; done"],
    networkMode,
    readonlyRootfs: true,
    memoryBytes: limits.memoryBytes,
    nanoCpus: limits.nanoCpus,
    pidsLimit: limits.pidsLimit,
    tmpfs: {
      "/tmp": "rw,nosuid,nodev,noexec,size=67108864,mode=1777",
      [workspaceRoot]: `rw,nosuid,nodev,size=${limits.maxWorkspaceBytes},uid=${user.uid},gid=${user.gid},mode=0700`
    },
    labels: {
      "zhivex.sandbox": "1",
      "zhivex.environment-id": manifest.id,
      "zhivex.owner": ownerId,
      "zhivex.run-id": runId,
      "zhivex.fingerprint": binding.fingerprint
    },
    init: true
  });

  const restoreTar = async (containerId: string, workspaceTar: Uint8Array) => {
    const entries = stripTarRoot(unpackTar(workspaceTar), "workspace");
    if (entries.length === 0) return;
    await docker.putArchive(containerId, workspaceRoot, packTar(entries));
  };

  const bootContainer = async (
    runId: string,
    scopeKey: string,
    previous: SandboxLease | undefined,
    workspaceTar?: Uint8Array,
    imageId?: string,
    signal?: AbortSignal
  ) => {
    const throwIfCancelled = () => {
      if (signal?.aborted) throw new SandboxError("CANCELLED", "Sandbox acquire was cancelled.");
    };
    throwIfCancelled();
    const opened = await openNetwork(runId, scopeKey);
    throwIfCancelled();
    const spec = specFor(
      runId,
      opened ? opened.networkId : "none",
      opened ? `http://${opened.gateway}:${opened.proxy.port}` : undefined
    );
    if (imageId) spec.image = imageId;
    let createdId: string | undefined;
    try {
      const created = await docker.createContainer(spec);
      createdId = created.Id;
      await docker.startContainer(created.Id);
      if (workspaceTar) await restoreTar(created.Id, workspaceTar);
        else if (!imageId) {
        const entries = withParents(await seedEntries(signal), user.uid, user.gid);
        if (entries.length) await docker.putArchive(created.Id, workspaceRoot, packTar(entries));
      }
      throwIfCancelled();
      const now = clock();
      const lease: SandboxLease = {
        schemaVersion: 1,
        runId,
        scopeKey,
        environmentId: binding.environmentId,
        fingerprint: binding.fingerprint,
        workspaceId: binding.workspaceId,
        containerId: created.Id,
        networkId: opened?.networkId,
        revision: (previous?.revision ?? -1) + 1,
        status: "active",
        createdAt: previous?.createdAt ?? now,
        expiresAt: now + ttl
      };
      await leases.compareAndSwap(lease, previous?.revision);
      return lease;
    } catch (error) {
      if (createdId) await docker.removeContainer(createdId).catch(() => undefined);
      if (opened && opened.networkId !== previous?.networkId) {
        const current = await leases.load(runId, scopeKey).catch(() => undefined);
        if (current?.networkId !== opened.networkId) {
          if (proxies.get(proxyKey(runId, scopeKey))?.networkId === opened.networkId) {
            proxies.delete(proxyKey(runId, scopeKey));
            await opened.proxy.close().catch(() => undefined);
          }
          await docker.removeNetwork(opened.networkId).catch(() => undefined);
        }
      }
      throw error;
    }
  };

  const takeSnapshot = async (lease: SandboxLease): Promise<SandboxSnapshot> => {
    const archived = await docker.getArchive(lease.containerId, workspaceRoot, limits.maxWorkspaceBytes * 2 + 65_536);
    if (archived.stat.linkTarget) {
      throw new SandboxError("SYMLINK_DENIED", "Refusing to snapshot a symlinked workspace root.");
    }
    if (archived.tar.byteLength > limits.maxWorkspaceBytes * 2 + 65_536) {
      throw new SandboxError("LIMIT", "Workspace snapshot exceeds the configured size limit.");
    }
    const previous = await snapshots.load(lease.runId, lease.scopeKey);
    let imageId: string | undefined;
    if (snapshotMode === "docker-commit") {
      const committed = await docker.commitContainer(
        lease.containerId,
        "zhivex-sandbox",
        `${lease.runId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40) || "snapshot"}-${randomUUID().slice(0, 8)}`,
        {
          "zhivex.sandbox": "1",
          "zhivex.owner": ownerId,
          "zhivex.fingerprint": binding.fingerprint,
          "zhivex.run-id": lease.runId
        }
      );
      imageId = committed.Id;
    }
    const carried = collectImageIds(previous?.pendingImageIds, previous?.imageId);
    const pendingImageIds = carried.filter(id => id !== imageId);
    const snapshot = withPendingImages({
      schemaVersion: 1,
      id: `snap_${randomUUID()}`,
      runId: lease.runId,
      scopeKey: lease.scopeKey,
      mode: snapshotMode,
      imageId,
      workspaceTar: archived.tar,
      createdAt: clock()
    }, pendingImageIds);
    try {
      await snapshots.save(snapshot);
    } catch (error) {
      if (imageId) await retainUnsavedImage(previous, imageId);
      throw error;
    }
    if (!pendingImageIds.length) return snapshot;
    const { retained, failure } = await deleteSnapshotImages(pendingImageIds);
    if (retained.length !== pendingImageIds.length) {
      try {
        await snapshots.save(withPendingImages(snapshot, retained));
      } catch (saveError) {
        if (failure) throw failure;
        throw saveError;
      }
    }
    if (failure) throw failure;
    return withPendingImages(snapshot, retained);
  };

  const removeSnapshotImage = async (imageId: string) => {
    await docker.removeImage(imageId).catch((error: unknown) => {
      if (error instanceof SandboxError && error.code === "NOT_FOUND") return;
      throw error;
    });
  };

  const deleteSnapshotImages = async (ids: readonly string[]) => {
    const retained: string[] = [];
    let failure: unknown;
    for (const id of ids) {
      try {
        await removeSnapshotImage(id);
      } catch (error) {
        retained.push(id);
        failure ??= error;
      }
    }
    return { retained, failure };
  };

  const retainUnsavedImage = async (previous: SandboxSnapshot | undefined, imageId: string) => {
    if (previous) {
      const pending = collectImageIds(previous.pendingImageIds, imageId).filter(id => id !== previous.imageId);
      try {
        await snapshots.save(withPendingImages(previous, pending));
        return;
      } catch {
        // The replacement record was not stored. Delete the untracked image instead.
      }
    }
    await removeSnapshotImage(imageId).catch(() => undefined);
  };

  const loadSnapshot = async (runId: string, scopeKey: string) => snapshots.load(runId, scopeKey).catch((error: unknown) => {
    if (error instanceof SandboxError && (error.code === "NOT_FOUND" || error.code === "STORE_ID")) return undefined;
    throw error;
  });

  const retryPendingSnapshotImages = async (runId: string, scopeKey: string) => {
    const stored = await loadSnapshot(runId, scopeKey);
    if (!stored?.pendingImageIds?.length) return;
    const pending = collectImageIds(stored.pendingImageIds).filter(id => id !== stored.imageId);
    const { retained, failure } = await deleteSnapshotImages(pending);
    if (retained.length !== pending.length) {
      try {
        await snapshots.save(withPendingImages(stored, retained));
      } catch (saveError) {
        if (failure) throw failure;
        throw saveError;
      }
    }
    if (failure) throw failure;
  };

  const discardSnapshot = async (runId: string, scopeKey: string) => {
    const stored = await loadSnapshot(runId, scopeKey);
    if (!stored) return;
    const ids = collectImageIds(stored.pendingImageIds, stored.imageId);
    const { retained, failure } = await deleteSnapshotImages(ids);
    if (retained.length > 0) {
      const imageId = stored.imageId && retained.includes(stored.imageId) ? stored.imageId : undefined;
      try {
        await snapshots.save(withPendingImages({ ...stored, imageId }, retained.filter(id => id !== imageId)));
      } catch (saveError) {
        if (failure) throw failure;
        throw saveError;
      }
      throw failure ?? new SandboxError("DOCKER_API", "Sandbox snapshot image could not be removed.");
    }
    await snapshots.remove(runId, scopeKey);
  };

  const openSession = (initial: SandboxLease): DockerSandboxSession => {
    let lease = initial;
    let closed = false;
    let activeExecs = 0;
    const waiters: Array<() => void> = [];
    const assertOpen = () => {
      if (closed || lease.status !== "active") {
        throw new SandboxError("SANDBOX_CLOSED", "Sandbox session is closed.");
      }
    };
    let revisionChain: Promise<void> = Promise.resolve();
    let pendingTouch: Promise<void> | undefined;
    const enqueueLease = (operation: () => Promise<void>) => {
      const run = revisionChain.then(operation);
      revisionChain = run.then(() => undefined, () => undefined);
      return run;
    };
    const touch = () => {
      assertOpen();
      if (lease.expiresAt <= clock()) throw new SandboxError("LEASE_EXPIRED", `Sandbox lease for run "${lease.runId}" has expired.`);
      if (!pendingTouch) {
        const run = enqueueLease(async () => {
          if (lease.status !== "active") return;
          if (lease.expiresAt <= clock()) throw new SandboxError("LEASE_EXPIRED", `Sandbox lease for run "${lease.runId}" has expired.`);
          const next = { ...lease, expiresAt: clock() + ttl, revision: lease.revision + 1 };
          lease = await leases.compareAndSwap(next, lease.revision);
        });
        pendingTouch = run;
        void run.then(() => {
          if (pendingTouch === run) pendingTouch = undefined;
        }, () => {
          if (pendingTouch === run) pendingTouch = undefined;
        });
      }
      return pendingTouch;
    };
    const enter = async () => {
      if (activeExecs >= limits.maxConcurrentProcesses) {
        await new Promise<void>(resolve => waiters.push(resolve));
      }
      activeExecs += 1;
    };
    const leave = () => {
      activeExecs -= 1;
      waiters.shift()?.();
    };
    const containerExec = async (
      cmd: string[],
      timeoutMs: number,
      signal?: AbortSignal,
      marker?: string,
      maxOutputBytes = limits.maxProcessOutputBytes
    ): Promise<DockerExecResult> => {
      await enter();
      try {
        return await docker.exec(lease.containerId, {
          cmd,
          user: user.user,
          env: marker ? [`ZHIVEX_EXEC_ID=${marker}`, ...baseEnv()] : baseEnv(),
          workingDir: workspaceRoot,
          timeoutMs,
          maxOutputBytes,
          signal,
          marker
        });
      } finally {
        leave();
      }
    };

    const session: DockerSandboxSession = {
      kind: "docker-sandbox",
      manifest,
      binding,
      get containerId() {
        return lease.containerId;
      },
      authorize(request: AgentExecutionAuthorizationRequest) {
        try {
          authorizeTool(request, shell, access, undeclaredTools, limits.maxFileBytes);
          return { decision: "allow" };
        } catch (error) {
          return { decision: "deny", reason: error instanceof Error ? error.message : String(error) };
        }
      },
      async execute(_request, operation) {
        assertOpen();
        return raceDeadline(
          Promise.resolve().then(() => operation()),
          limits.maxProcessRuntimeMs,
          "Sandbox tool callback exceeded its deadline."
        );
      },
      async readFile(filePath: string) {
        assertOpen();
        await touch();
        const absolute = resolveWorkspacePath(workspaceRoot, filePath);
        await assertResolvedWorkspacePath(docker, lease.containerId, workspaceRoot, absolute);
        const archived = await docker.getArchive(lease.containerId, absolute, limits.maxFileBytes + 8_192);
        if (archived.stat.linkTarget) {
          throw new SandboxError("SYMLINK_DENIED", "Sandbox file reads do not follow symlinks.");
        }
        const file = unpackTar(archived.tar).find(entry => entry.type === "file");
        if (!file?.content) throw new SandboxError("NOT_FOUND", `Sandbox file ${filePath} was not found.`);
        if (file.content.byteLength > limits.maxFileBytes) {
          throw new SandboxError("LIMIT", "Sandbox file exceeds maxFileBytes.");
        }
        return file.content;
      },
      async writeFile(filePath: string, contents: Uint8Array | string) {
        assertOpen();
        if (access !== "read-write") throw new SandboxError("READ_ONLY", "Sandbox workspace is read-only.");
        await touch();
        const absolute = resolveWorkspacePath(workspaceRoot, filePath);
        await assertResolvedWorkspacePath(docker, lease.containerId, workspaceRoot, absolute);
        const bytes = await boundedBytes(typeof contents === "string" ? encoder.encode(contents) : contents, limits.maxFileBytes, filePath);
        const relative = absolute.slice(workspaceRoot.length + 1);
        await docker.putArchive(lease.containerId, workspaceRoot, packTar(withParents([{
          path: relative,
          type: "file",
          content: bytes,
          mode: 0o644,
          uid: user.uid,
          gid: user.gid
        }], user.uid, user.gid)));
      },
      async list(filePath = ".") {
        assertOpen();
        await touch();
        const absolute = resolveWorkspacePath(workspaceRoot, filePath);
        await assertResolvedWorkspacePath(docker, lease.containerId, workspaceRoot, absolute);
        const listCap = Math.max(limits.maxProcessOutputBytes, 65_536);
        const result = await containerExec(["/bin/ls", "-1A", absolute], limits.maxProcessRuntimeMs, undefined, undefined, listCap);
        if (result.truncated) {
          throw new SandboxError("LIMIT", "Sandbox directory listing exceeds the output cap.");
        }
        if (result.exitCode !== 0) {
          throw new SandboxError("NOT_FOUND", decodeCappedText(result.stderr, 500).text || `Sandbox path ${filePath} was not found.`);
        }
        return decodeCappedText(result.stdout, listCap).text.split("\n").filter(Boolean);
      },
      async exec(argv, execOptions) {
        assertOpen();
        const command = validateArgv([...argv], shell);
        const timeoutMs = Math.min(execOptions?.timeoutMs ?? limits.maxProcessRuntimeMs, limits.maxProcessRuntimeMs);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
          throw new SandboxError("LIMIT", "Command timeout must be a positive integer millisecond value.");
        }
        await touch();
        const marker = `zhivex_${randomUUID()}`;
        const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
        const groupScript = 'sec="$1"; shift; setsid /usr/bin/timeout -s KILL "$sec" "$@" & leader=$!; wait "$leader"; status=$?; kill -KILL -"$leader" 2>/dev/null; exit "$status"';
        const result = await containerExec(
          ["/bin/sh", "-c", groupScript, marker, seconds, ...command],
          timeoutMs,
          execOptions?.signal,
          marker
        );
        const stdout = decodeCappedText(result.stdout, limits.maxProcessOutputBytes);
        const stderr = decodeCappedText(result.stderr, limits.maxProcessOutputBytes);
        return {
          exitCode: result.exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          truncated: result.truncated || stdout.truncated || stderr.truncated,
          timedOut: result.timedOut
        };
      },
      async snapshot() {
        assertOpen();
        const snapshot = await takeSnapshot(lease);
        await enqueueLease(async () => {
          const next = { ...lease, snapshotId: snapshot.id, revision: lease.revision + 1, expiresAt: clock() + ttl };
          lease = await leases.compareAndSwap(next, lease.revision);
        });
        return { id: snapshot.id, mode: snapshot.mode, imageId: snapshot.imageId };
      },
      async release(result) {
        if (closed) return;
        closed = true;
        if (!terminalStatus.has(result.status)) {
          const snapshot = await takeSnapshot(lease);
          await enqueueLease(async () => {
            const next = { ...lease, snapshotId: snapshot.id, revision: lease.revision + 1, expiresAt: clock() + ttl };
            lease = await leases.compareAndSwap(next, lease.revision);
          });
          return;
        }
        await enqueueLease(async () => {
          const next = { ...lease, status: "released" as const, revision: lease.revision + 1, expiresAt: clock() };
          lease = await leases.compareAndSwap(next, lease.revision);
        });
        try {
          await docker.removeContainer(lease.containerId).catch((error: unknown) => {
            if (!(error instanceof SandboxError) || error.code !== "NOT_FOUND") throw error;
          });
          await discardSnapshot(lease.runId, lease.scopeKey);
        } finally {
          if (lease.networkId) await docker.removeNetwork(lease.networkId).catch(() => undefined);
          const proxy = proxies.get(proxyKey(lease.runId, lease.scopeKey));
          proxies.delete(proxyKey(lease.runId, lease.scopeKey));
          await proxy?.proxy.close().catch(() => undefined);
        }
      }
    };
    return session;
  };

  return {
    manifest,
    async acquire(request) {
      if (request.abortSignal?.aborted) throw new SandboxError("CANCELLED", "Sandbox acquire was cancelled.");
      const scopeKey = scopeKeyOf(request.scope);
      const existing = await leases.load(request.runId, scopeKey);
      if (existing && (
        existing.fingerprint !== binding.fingerprint ||
        existing.environmentId !== binding.environmentId ||
        existing.workspaceId !== binding.workspaceId
      )) {
        throw new ConflictError(`Execution environment binding changed for agent run "${request.runId}".`);
      }
      if (existing?.status === "released") {
        throw new SandboxError("SANDBOX_RELEASED", `Sandbox for run "${request.runId}" was already released.`);
      }
      if (existing && (existing.status === "expired" || existing.expiresAt <= clock())) {
        if (existing.status === "active") {
          await docker.removeContainer(existing.containerId).catch(() => undefined);
          if (existing.networkId) await docker.removeNetwork(existing.networkId).catch(() => undefined);
          const proxy = proxies.get(proxyKey(request.runId, scopeKey));
          proxies.delete(proxyKey(request.runId, scopeKey));
          await proxy?.proxy.close().catch(() => undefined);
          const expired = { ...existing, status: "expired" as const, revision: existing.revision + 1 };
          await leases.compareAndSwap(expired, existing.revision).catch(() => undefined);
        }
        await discardSnapshot(request.runId, scopeKey);
        throw new SandboxError("LEASE_EXPIRED", `Sandbox lease for run "${request.runId}" has expired.`);
      }
      if (!existing) {
        const lease = await bootContainer(request.runId, scopeKey, undefined, undefined, undefined, request.abortSignal);
        return openSession(lease);
      }
      let running = false;
      let inspection: DockerContainerInspection | undefined;
      try {
        inspection = await docker.inspectContainer(existing.containerId);
        running = inspection.State.Running;
      } catch (error) {
        if (!(error instanceof SandboxError) || error.code !== "NOT_FOUND") throw error;
      }
      const proxyAlive = !allowlist || proxies.has(proxyKey(request.runId, scopeKey));
      if (running && proxyAlive) {
        const host = inspection?.HostConfig;
        if (host && (host.NanoCpus !== limits.nanoCpus || host.PidsLimit !== limits.pidsLimit || host.Memory !== limits.memoryBytes)) {
          throw new ConflictError(`Execution environment binding changed for agent run "${request.runId}".`);
        }
        const renewed = { ...existing, expiresAt: clock() + ttl, revision: existing.revision + 1 };
        await leases.compareAndSwap(renewed, existing.revision);
        return openSession(renewed);
      }
      let workspaceTar: Uint8Array | undefined;
      let imageId: string | undefined;
      if (running) {
        workspaceTar = (await docker.getArchive(existing.containerId, workspaceRoot, limits.maxWorkspaceBytes * 2 + 65_536)).tar;
        await docker.removeContainer(existing.containerId).catch(() => undefined);
      }
      const stored = await snapshots.load(request.runId, scopeKey);
      workspaceTar ??= stored?.workspaceTar;
      imageId = stored?.imageId;
      if (!workspaceTar && !imageId) {
        throw new SandboxError("SANDBOX_LOST", `Sandbox container for run "${request.runId}" is gone and no snapshot is available.`);
      }
      await docker.removeContainer(existing.containerId).catch(() => undefined);
      if (!proxyAlive && existing.networkId) {
        await docker.removeNetwork(existing.networkId).catch(() => undefined);
      }
      const lease = await bootContainer(request.runId, scopeKey, existing, workspaceTar, imageId, request.abortSignal);
      return openSession(lease);
    },
    async sweep(now = clock()) {
      const removed: string[] = [];
      for (const lease of await leases.list()) {
        if (lease.environmentId !== manifest.id || lease.fingerprint !== binding.fingerprint) continue;
        if (lease.status === "active" && lease.expiresAt > now) {
          await retryPendingSnapshotImages(lease.runId, lease.scopeKey);
          continue;
        }
        await discardSnapshot(lease.runId, lease.scopeKey);
        if (lease.status !== "active") continue;
        await docker.removeContainer(lease.containerId).catch(() => undefined);
        if (lease.networkId) await docker.removeNetwork(lease.networkId).catch(() => undefined);
        const proxy = proxies.get(proxyKey(lease.runId, lease.scopeKey));
        proxies.delete(proxyKey(lease.runId, lease.scopeKey));
        await proxy?.proxy.close();
        await leases.compareAndSwap({ ...lease, status: "expired", revision: lease.revision + 1 }, lease.revision).catch(() => undefined);
        removed.push(lease.containerId);
      }
      const active = new Set((await leases.list()).filter(lease => lease.status === "active").map(lease => lease.containerId));
      for (const container of await docker.listContainers("zhivex.sandbox=1")) {
        const labels = container.Labels;
        if (labels["zhivex.environment-id"] !== manifest.id) continue;
        if (labels["zhivex.owner"] !== ownerId || labels["zhivex.fingerprint"] !== binding.fingerprint) continue;
        if (active.has(container.Id)) continue;
        await docker.removeContainer(container.Id).catch(() => undefined);
        removed.push(container.Id);
      }
      return { removedContainerIds: removed };
    }
  };
};

const IMAGE_ID = /^[A-Za-z0-9:_./@+-]{1,200}$/;

const collectImageIds = (...groups: Array<string | readonly string[] | undefined>) => {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const group of groups) {
    if (group === undefined) continue;
    const values = typeof group === "string" ? [group] : group;
    if (!Array.isArray(values)) {
      throw new SandboxError("SNAPSHOT_INVALID", "Sandbox snapshot image ids are not usable.");
    }
    for (const id of values) {
      if (typeof id !== "string" || !IMAGE_ID.test(id)) {
        throw new SandboxError("SNAPSHOT_INVALID", "Sandbox snapshot image id is not usable.");
      }
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length > 32) {
    throw new SandboxError("SNAPSHOT_INVALID", "Sandbox snapshot has too many images waiting for deletion.");
  }
  return ids;
};

const withPendingImages = (snapshot: SandboxSnapshot, pending: readonly string[]): SandboxSnapshot => {
  const next: SandboxSnapshot = { ...snapshot };
  if (pending.length) next.pendingImageIds = [...pending];
  else delete next.pendingImageIds;
  if (!next.imageId) delete next.imageId;
  return next;
};

const withParents = (entries: readonly TarEntry[], uid: number, gid: number): TarEntry[] => {
  const directories = new Set(entries.filter(entry => entry.type === "directory").map(entry => entry.path));
  const parents: TarEntry[] = [];
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let prefix = "";
    for (const part of parts.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (directories.has(prefix)) continue;
      directories.add(prefix);
      parents.push({ path: prefix, type: "directory", mode: 0o755, uid, gid });
    }
  }
  return [...parents, ...entries];
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;

const clampTimeout = (timeoutMs: number) => {
  if (!Number.isFinite(timeoutMs)) return 1;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.floor(timeoutMs)));
};

const raceDeadline = <T>(operation: Promise<T>, timeoutMs: number, message: string) =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new SandboxError("LIMIT", message));
    }, clampTimeout(timeoutMs));
    operation.then(value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

const boundedBytes = async (bytes: Uint8Array, max: number, label: string) => {
  if (bytes.byteLength > max) throw new SandboxError("LIMIT", `Sandbox file ${label} exceeds maxFileBytes.`);
  return bytes;
};

const throwIfSourceAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new SandboxError("CANCELLED", "Sandbox source import was cancelled.");
};

const assertResolvedWorkspacePath = async (
  docker: DockerClient,
  containerId: string,
  workspaceRoot: string,
  absolute: string
) => {
  const suffix: string[] = [];
  let probe = absolute;
  while (true) {
    try {
      const canonical = await docker.realpath(containerId, probe);
      const rebuilt = suffix.length === 0 ? canonical : path.posix.join(canonical, ...suffix);
      if (rebuilt !== absolute || (rebuilt !== workspaceRoot && !rebuilt.startsWith(`${workspaceRoot}/`))) {
        throw new SandboxError("SYMLINK_DENIED", "Sandbox paths do not follow symlinks.");
      }
      return;
    } catch (error) {
      if (!(error instanceof SandboxError) || error.code !== "NOT_FOUND") throw error;
      if (probe === workspaceRoot || probe === "/") {
        throw new SandboxError("NOT_FOUND", `Sandbox path ${absolute} was not found.`);
      }
      const parent = path.posix.dirname(probe);
      if (parent === probe) throw new SandboxError("NOT_FOUND", `Sandbox path ${absolute} was not found.`);
      suffix.unshift(path.posix.basename(probe));
      probe = parent;
    }
  }
};

const readSourceTree = async (
  root: string,
  include: readonly string[],
  limits: ResolvedLimits,
  uid: number,
  gid: number,
  budget: { remaining: number },
  signal?: AbortSignal
): Promise<TarEntry[]> => {
  sourceBytesRead = 0;
  const realRoot = path.resolve(root);
  const rootStat = await lstat(realRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new SandboxError("WORKSPACE_SOURCE", "Sandbox source root must be a directory.");
  }
  const entries: TarEntry[] = [];
  for (const relative of include) {
    throwIfSourceAborted(signal);
    const safe = assertRelativeWorkspacePath(relative);
    const absolute = path.resolve(realRoot, safe);
    if (absolute !== realRoot && !absolute.startsWith(`${realRoot}${path.sep}`)) {
      throw new SandboxError("PATH_ESCAPE", `Source path ${relative} escapes the source root.`);
    }
    await copySource(absolute, safe, entries, limits, uid, gid, 0, budget, signal);
  }
  return entries;
};

const copySource = async (
  absolute: string,
  relative: string,
  entries: TarEntry[],
  limits: ResolvedLimits,
  uid: number,
  gid: number,
  depth: number,
  budget: { remaining: number },
  signal?: AbortSignal
) => {
  throwIfSourceAborted(signal);
  if (depth > 32 || entries.length > 1000) {
    throw new SandboxError("LIMIT", "Sandbox source copy exceeds the file or depth limit.");
  }
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new SandboxError("SYMLINK_DENIED", `Refusing to copy symlink ${relative}.`);
  if (info.isDirectory()) {
    entries.push({ path: relative, type: "directory", mode: 0o755, uid, gid });
    for (const name of (await readdir(absolute)).sort()) {
      await copySource(path.join(absolute, name), `${relative}/${name}`, entries, limits, uid, gid, depth + 1, budget, signal);
    }
    return;
  }
  if (!info.isFile()) throw new SandboxError("WORKSPACE_SOURCE", `Source path ${relative} is not a regular file.`);
  if (info.size > limits.maxFileBytes) {
    throw new SandboxError("LIMIT", `Source file ${relative} exceeds maxFileBytes.`);
  }
  if (info.size > budget.remaining) {
    throw new SandboxError("LIMIT", `Source file ${relative} exceeds maxWorkspaceBytes.`);
  }
  const content = await readBoundedFile(absolute, relative, limits.maxFileBytes, budget.remaining);
  budget.remaining -= content.byteLength;
  entries.push({ path: relative, type: "file", content, mode: 0o644, uid, gid });
};

const readBoundedFile = async (absolute: string, relative: string, maxFileBytes: number, remaining: number) => {
  const cap = Math.min(maxFileBytes, remaining);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new SandboxError("WORKSPACE_SOURCE", `Source path ${relative} is not a regular file.`);
    if (info.size > maxFileBytes) throw new SandboxError("LIMIT", `Source file ${relative} exceeds maxFileBytes.`);
    if (info.size > remaining) throw new SandboxError("LIMIT", `Source file ${relative} exceeds maxWorkspaceBytes.`);
    const target = new Uint8Array(info.size);
    let offset = 0;
    while (offset < info.size) {
      const chunk = await handle.read(target, offset, Math.min(65_536, info.size - offset), offset);
      if (chunk.bytesRead <= 0) break;
      offset += chunk.bytesRead;
      sourceBytesRead += chunk.bytesRead;
      if (offset > cap) throw new SandboxError("LIMIT", `Source file ${relative} exceeds maxFileBytes.`);
    }
    if (offset !== info.size) {
      throw new SandboxError("WORKSPACE_SOURCE", `Source file ${relative} changed while it was read.`);
    }
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SandboxError("SYMLINK_DENIED", `Refusing to copy symlink ${relative}.`);
    }
    throw error;
  } finally {
    await handle.close();
  }
};

const authorizeTool = (
  request: AgentExecutionAuthorizationRequest,
  shell: ShellPolicy,
  access: "read-only" | "read-write",
  undeclaredTools: "allow" | "deny",
  maxFileBytes: number
) => {
  const input = request.input && typeof request.input === "object" ? request.input as Record<string, unknown> : undefined;
  if (request.tool.name === "sandbox_read_file" || request.tool.name === "sandbox_list") {
    if (typeof input?.path === "string") resolveWorkspacePath("/workspace", input.path);
    else if (request.tool.name === "sandbox_read_file") throw new SandboxError("PATH_INVALID", "sandbox_read_file requires a path.");
    return;
  }
  if (request.tool.name === "sandbox_write_file") {
    if (access !== "read-write") throw new SandboxError("READ_ONLY", "Sandbox workspace is read-only.");
    if (typeof input?.path !== "string") throw new SandboxError("PATH_INVALID", "sandbox_write_file requires a path.");
    resolveWorkspacePath("/workspace", input.path);
    const contents = typeof input.contents === "string" ? encoder.encode(input.contents) : undefined;
    if (!contents) throw new SandboxError("PATH_INVALID", "sandbox_write_file requires string contents.");
    if (contents.byteLength > maxFileBytes) throw new SandboxError("LIMIT", "Sandbox write exceeds maxFileBytes.");
    return;
  }
  if (request.tool.name === "sandbox_exec") {
    validateArgv(input?.argv, shell);
    return;
  }
  if (undeclaredTools === "deny") {
    throw new SandboxError("TOOL_DENIED", `Tool "${request.tool.name}" is not declared for this sandbox.`);
  }
};

export const isDockerSandboxSession = (value: unknown): value is DockerSandboxSession =>
  Boolean(value) && typeof value === "object" && (value as { kind?: string }).kind === "docker-sandbox";
