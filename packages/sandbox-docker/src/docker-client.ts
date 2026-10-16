import http from "node:http";

import { SandboxError } from "./errors.js";
import { readMultiplexedStream } from "./stream.js";
import { unpackTar } from "./tar.js";

export interface DockerPathStat {
  name: string;
  size: number;
  mode: number;
  linkTarget: string;
}

export interface DockerCreateSpec {
  image: string;
  user: string;
  workingDir: string;
  env: string[];
  cmd: string[];
  networkMode: string;
  readonlyRootfs: boolean;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  tmpfs: Record<string, string>;
  labels: Record<string, string>;
  init: boolean;
}

export interface DockerExecOptions {
  cmd: string[];
  user: string;
  env?: string[];
  workingDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Internal kill helper must not recurse into another terminate attempt. */
  skipTerminate?: boolean;
  marker?: string;
}

export interface DockerExecResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
  timedOut: boolean;
}

export interface DockerContainerInspection {
  Id: string;
  State: {
    Running: boolean;
    Status: string;
    OOMKilled: boolean;
    ExitCode: number;
  };
  HostConfig?: {
    NanoCpus?: number;
    PidsLimit?: number;
    Memory?: number;
  };
}

export interface DockerListedContainer {
  Id: string;
  Labels: Record<string, string>;
}

export interface DockerClient {
  readonly kind: "node" | "memory";
  createContainer(spec: DockerCreateSpec): Promise<{ Id: string }>;
  startContainer(id: string): Promise<void>;
  inspectContainer(id: string): Promise<DockerContainerInspection>;
  removeContainer(id: string): Promise<void>;
  killContainer(id: string, signal?: string): Promise<void>;
  listContainers(label: string): Promise<DockerListedContainer[]>;
  putArchive(id: string, containerPath: string, tar: Uint8Array): Promise<void>;
  getArchive(id: string, containerPath: string, maxOutputBytes?: number): Promise<{ tar: Uint8Array; stat: DockerPathStat }>;
  exec(id: string, options: DockerExecOptions): Promise<DockerExecResult>;
  /** Canonicalize a container path. Callers compare it with the lexical path and refuse escapes. */
  realpath(id: string, containerPath: string): Promise<string>;
  commitContainer(id: string, repo: string, tag: string, labels?: Record<string, string>): Promise<{ Id: string }>;
  removeImage(id: string): Promise<void>;
  createNetwork(name: string): Promise<{ Id: string; gateway?: string }>;
  removeNetwork(id: string): Promise<void>;
}

const empty = new Uint8Array();
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TAR_EXTRACT_DEADLINE_MS = 30_000;

const clampTimeout = (timeoutMs: number) => {
  if (!Number.isFinite(timeoutMs)) return 1;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.floor(timeoutMs)));
};

export interface NodeDockerClientOptions {
  socketPath?: string;
  apiVersion?: string;
}

export const createNodeDockerClient = (options: NodeDockerClientOptions = {}): DockerClient => {
  const socketPath = options.socketPath ?? "/var/run/docker.sock";
  let apiVersion = options.apiVersion;
  const prefix = () => `/${apiVersion}`;

  const request = (method: string, requestPath: string, body?: Uint8Array, headers?: Record<string, string>, signal?: AbortSignal) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const payload = body ? Buffer.from(body) : undefined;
      const req = http.request({
        socketPath,
        method,
        path: requestPath,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}),
          ...headers
        },
        signal
      }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks)
        }));
      });
      req.on("error", error => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ECONNREFUSED") {
          reject(new SandboxError("DOCKER_UNAVAILABLE", `Docker socket ${socketPath} is not available.`, { cause: error }));
          return;
        }
        reject(error);
      });
      req.end(payload);
    });

  const ensureVersion = async () => {
    if (apiVersion) return;
    const response = await request("GET", "/version");
    if (response.status >= 300) {
      throw new SandboxError("DOCKER_API", dockerMessage(response.body) || "Docker /version failed.");
    }
    const info = JSON.parse(response.body.toString("utf8")) as { ApiVersion?: string };
    if (!info.ApiVersion || !/^\d+\.\d+$/.test(info.ApiVersion)) {
      throw new SandboxError("DOCKER_API", "Docker /version did not report an API version.");
    }
    apiVersion = `v${info.ApiVersion}`;
  };

  const requestJson = async <T>(method: string, requestPath: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    await ensureVersion();
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const response = await request(method, `${prefix()}${requestPath}`, payload, undefined, signal);
    if (response.status === 404) {
      throw new SandboxError("NOT_FOUND", dockerMessage(response.body) || `Docker resource was not found: ${requestPath}`);
    }
    if (response.status >= 300) {
      throw new SandboxError("DOCKER_API", dockerMessage(response.body) || `Docker API ${method} ${requestPath} returned ${response.status}.`);
    }
    if (response.body.length === 0) return undefined as T;
    return JSON.parse(response.body.toString("utf8")) as T;
  };

  const terminate = async (id: string, marker: string, user: string) => {
    const top = await requestJson<{ Titles?: string[]; Processes?: string[][] }>("GET", `/containers/${id}/top?ps_args=${encodeURIComponent("e -o pid,pgid,args")}`);
    const titles = top.Titles ?? [];
    const pidIndex = titles.findIndex(title => title.toUpperCase() === "PID");
    const pgidIndex = titles.findIndex(title => title.toUpperCase() === "PGID");
    const argsIndex = Math.max(0, titles.findIndex(title => /cmd|command|args/i.test(title)));
    const groups = new Set<string>();
    for (const row of top.Processes ?? []) {
      if (!(row[argsIndex] ?? "").includes(marker)) continue;
      const pgid = pgidIndex === -1 ? row[pidIndex === -1 ? 0 : pidIndex] : row[pgidIndex];
      if (!pgid || pgid === "0" || pgid === "1") continue;
      groups.add(`-${pgid}`);
    }
    if (!groups.size) return;
    await ensureVersion();
    await createNodeDockerClient({ socketPath, apiVersion }).exec(id, {
      cmd: ["/bin/kill", "-KILL", "--", ...groups],
      user,
      workingDir: "/",
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
      skipTerminate: true
    });
  };

  return {
    kind: "node",
    async createContainer(spec) {
      return requestJson("POST", "/containers/create", {
        Image: spec.image,
        User: spec.user,
        WorkingDir: spec.workingDir,
        Env: spec.env,
        Cmd: spec.cmd,
        Labels: spec.labels,
        HostConfig: {
          NetworkMode: spec.networkMode,
          ReadonlyRootfs: spec.readonlyRootfs,
          Memory: spec.memoryBytes,
          MemorySwap: spec.memoryBytes,
          NanoCpus: spec.nanoCpus,
          PidsLimit: spec.pidsLimit,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Init: spec.init,
          Tmpfs: spec.tmpfs
        }
      });
    },
    async startContainer(id) {
      await requestJson("POST", `/containers/${id}/start`);
    },
    async inspectContainer(id) {
      return requestJson("GET", `/containers/${id}/json`);
    },
    async removeContainer(id) {
      await requestJson("DELETE", `/containers/${id}?force=true`);
    },
    async killContainer(id, signal = "SIGKILL") {
      await requestJson("POST", `/containers/${id}/kill?signal=${encodeURIComponent(signal)}`);
    },
    async listContainers(label) {
      const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
      const listed = await requestJson<Array<{ Id: string; Labels?: Record<string, string> }>>("GET", `/containers/json?all=true&filters=${filters}`);
      return listed.map(container => ({ Id: container.Id, Labels: container.Labels ?? {} }));
    },
    async putArchive(id, containerPath, tar) {
      await ensureVersion();
      const response = await request("PUT", `${prefix()}/containers/${id}/archive?path=${encodeURIComponent(containerPath)}`, tar, {
        "Content-Type": "application/x-tar",
        "Content-Length": String(tar.byteLength)
      });
      if (response.status < 300) return;
      const message = dockerMessage(response.body) || `Docker archive upload returned ${response.status}.`;
      if (!/read-only/i.test(message)) throw new SandboxError("DOCKER_API", message);
      await extractTar(socketPath, prefix(), id, containerPath, tar);
    },
    async getArchive(id, containerPath, maxOutputBytes = 256 * 1024 * 1024) {
      const slash = containerPath.lastIndexOf("/");
      const parent = slash <= 0 ? "/" : containerPath.slice(0, slash);
      const name = containerPath.slice(slash + 1);
      if (!name || name === "." || name === ".." || name.includes("/")) {
        throw new SandboxError("PATH_INVALID", `Sandbox archive path ${containerPath} is not a single container path.`);
      }
      const archived = await this.exec(id, {
        cmd: ["/bin/tar", "-c", "-C", parent, name],
        user: "",
        workingDir: "/",
        timeoutMs: 30_000,
        maxOutputBytes,
        skipTerminate: true
      });
      if (archived.timedOut || archived.truncated) {
        throw new SandboxError("LIMIT", "Sandbox archive exceeds the output cap.");
      }
      if (archived.exitCode !== 0) {
        const detail = new TextDecoder().decode(archived.stderr).trim();
        throw new SandboxError("NOT_FOUND", detail || `Sandbox path ${containerPath} was not found.`);
      }
      const entries = unpackTar(archived.stdout);
      const root = entries.find(entry => entry.path === name);
      return {
        tar: archived.stdout,
        stat: {
          name,
          size: root?.content?.byteLength ?? 0,
          mode: root?.mode ?? 0,
          linkTarget: root?.type === "symlink" ? root.linkTarget ?? "" : ""
        }
      };
    },
    async exec(id, options) {
      const marker = options.marker ?? "";
      const created = await requestJson<{ Id: string }>("POST", `/containers/${id}/exec`, {
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        ...(options.user ? { User: options.user } : {}),
        WorkingDir: options.workingDir,
        Env: options.env,
        Cmd: options.cmd
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), clampTimeout(options.timeoutMs));
      const onAbort = () => controller.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      try {
        const streamed = await streamExec(socketPath, prefix(), created.Id, options.maxOutputBytes, controller.signal);
        timedOut = controller.signal.aborted && !options.signal?.aborted;
        const inspected = await requestJson<{ ExitCode?: number }>("GET", `/exec/${created.Id}/json`).catch(() => ({ ExitCode: timedOut ? 137 : 1 }));
        if (options.signal?.aborted) {
          throw new SandboxError("CANCELLED", "Sandbox command was cancelled.");
        }
        return {
          exitCode: inspected.ExitCode ?? (timedOut ? 137 : 1),
          stdout: streamed.stdout,
          stderr: streamed.stderr,
          truncated: streamed.truncated,
          timedOut
        };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (!options.skipTerminate && marker) {
          await terminate(id, marker, options.user).catch(() => undefined);
        }
      }
    },
    async realpath(id, containerPath) {
      if (!containerPath.startsWith("/") || containerPath.includes("\0") || containerPath.length > 4096) {
        throw new SandboxError("PATH_INVALID", "Sandbox realpath requires an absolute container path.");
      }
      const result = await this.exec(id, {
        // Alpine busybox links this applet at /usr/bin/realpath. /bin/realpath is absent.
        cmd: ["/usr/bin/realpath", containerPath],
        user: "",
        workingDir: "/",
        timeoutMs: 5_000,
        maxOutputBytes: 8_192,
        skipTerminate: true
      });
      if (result.exitCode !== 0 || result.timedOut || result.truncated) {
        throw new SandboxError("NOT_FOUND", `Sandbox path ${containerPath} was not found.`);
      }
      const resolved = new TextDecoder().decode(result.stdout).replace(/\n$/, "");
      if (!resolved.startsWith("/") || resolved.includes("\0")) {
        throw new SandboxError("PATH_INVALID", "Sandbox realpath returned an unusable path.");
      }
      return resolved;
    },
    async commitContainer(id, repo, tag, labels) {
      return requestJson(
        "POST",
        `/commit?container=${encodeURIComponent(id)}&repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
        labels ? { Labels: labels } : undefined
      );
    },
    async removeImage(id) {
      await requestJson("DELETE", `/images/${encodeURIComponent(id)}?force=true`);
    },
    async createNetwork(name) {
      const created = await requestJson<{ Id: string }>("POST", "/networks/create", {
        Name: name,
        Internal: true,
        CheckDuplicate: true,
        Labels: { "zhivex.sandbox": "1" }
      });
      const inspected = await requestJson<{ IPAM?: { Config?: Array<{ Gateway?: string }> } }>("GET", `/networks/${created.Id}`);
      return { Id: created.Id, gateway: inspected.IPAM?.Config?.[0]?.Gateway };
    },
    async removeNetwork(id) {
      await requestJson("DELETE", `/networks/${id}`);
    }
  };
};

const extractTar = (socketPath: string, apiPrefix: string, id: string, containerPath: string, tar: Uint8Array) =>
  new Promise<void>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TAR_EXTRACT_DEADLINE_MS);
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve();
    };
    controller.signal.addEventListener("abort", () => {
      finish(new SandboxError("LIMIT", "Sandbox tar extract exceeded its deadline."));
    }, { once: true });
    const createBody = Buffer.from(JSON.stringify({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ["/bin/tar", "-x", "-C", containerPath]
    }));
    const create = http.request({
      socketPath,
      method: "POST",
      path: `${apiPrefix}/containers/${id}/exec`,
      headers: { "Content-Type": "application/json", "Content-Length": String(createBody.length) },
      signal: controller.signal
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        if ((response.statusCode ?? 500) >= 300) {
          finish(new SandboxError("DOCKER_API", dockerMessage(body) || "Docker tar exec create failed."));
          return;
        }
        const created = JSON.parse(body.toString("utf8")) as { Id?: string };
        if (!created.Id) {
          finish(new SandboxError("DOCKER_API", "Docker tar exec did not return an id."));
          return;
        }
        startTarExtract(socketPath, apiPrefix, created.Id, tar, controller.signal).then(() => finish(), finish);
      });
    });
    create.on("error", error => {
      if (controller.signal.aborted) finish(new SandboxError("LIMIT", "Sandbox tar extract exceeded its deadline."));
      else finish(error);
    });
    create.end(createBody);
  });

const startTarExtract = (socketPath: string, apiPrefix: string, execId: string, tar: Uint8Array, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve();
    };
    const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
    const req = http.request({
      socketPath,
      method: "POST",
      path: `${apiPrefix}/exec/${execId}/start`,
      headers: {
        "Content-Type": "application/json",
        Connection: "Upgrade",
        Upgrade: "tcp",
        "Content-Length": String(payload.length)
      },
      signal
    });
    let upgraded: import("node:net").Socket | undefined;
    const fail = (error: unknown) => {
      upgraded?.destroy();
      req.destroy();
      finish(error);
    };
    signal.addEventListener("abort", () => fail(new SandboxError("LIMIT", "Sandbox tar extract exceeded its deadline.")), { once: true });
    req.on("upgrade", (_response, socket) => {
      upgraded = socket;
      const output: Buffer[] = [];
      socket.on("data", chunk => output.push(Buffer.from(chunk)));
      socket.on("error", fail);
      socket.on("end", () => {
        inspectExec(socketPath, apiPrefix, execId, signal).then(exitCode => {
          if (exitCode !== 0) {
            fail(new SandboxError("DOCKER_API", `Sandbox tar extract exited ${exitCode}: ${Buffer.concat(output).toString("utf8").slice(0, 300)}`));
            return;
          }
          finish();
        }).catch(fail);
      });
      socket.end(tar);
    });
    req.on("response", response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => fail(new SandboxError("DOCKER_API", dockerMessage(Buffer.concat(chunks)) || "Docker tar extract did not upgrade the connection.")));
    });
    req.on("error", error => {
      if (signal.aborted) fail(new SandboxError("LIMIT", "Sandbox tar extract exceeded its deadline."));
      else fail(error);
    });
    req.end(payload);
  });

const inspectExec = (socketPath: string, apiPrefix: string, execId: string, signal: AbortSignal) =>
  new Promise<number>((resolve, reject) => {
    const req = http.request({
      socketPath,
      method: "GET",
      path: `${apiPrefix}/exec/${execId}/json`,
      signal
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        if ((response.statusCode ?? 500) >= 300) {
          reject(new SandboxError("DOCKER_API", dockerMessage(body) || "Docker exec inspect failed."));
          return;
        }
        const inspected = JSON.parse(body.toString("utf8")) as { ExitCode?: number };
        resolve(inspected.ExitCode ?? 1);
      });
    });
    req.on("error", reject);
    req.end();
  });

const dockerMessage = (body: Buffer) => {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { message?: string };
    return parsed.message ?? "";
  } catch {
    return body.toString("utf8").slice(0, 300);
  }
};

const streamExec = (socketPath: string, prefix: string, execId: string, maxBytes: number, signal: AbortSignal) =>
  new Promise<{ stdout: Uint8Array; stderr: Uint8Array; truncated: boolean }>((resolve, reject) => {
    let settled = false;
    const finish = (value: { stdout: Uint8Array; stderr: Uint8Array; truncated: boolean }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
    const req = http.request({
      socketPath,
      method: "POST",
      path: `${prefix}/exec/${execId}/start`,
      headers: { "Content-Type": "application/json", "Content-Length": String(payload.length) },
      signal
    }, response => {
      if ((response.statusCode ?? 500) >= 300) {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () => fail(new SandboxError("DOCKER_API", dockerMessage(Buffer.concat(chunks)) || "Docker exec start failed.")));
        return;
      }
      void readMultiplexedStream(response, maxBytes).then(result => {
        if (result.truncated) response.destroy();
        finish(result);
      }).catch(error => {
        if (signal.aborted) finish({ stdout: empty, stderr: empty, truncated: false });
        else fail(error);
      });
    });
    req.on("error", error => {
      if (signal.aborted) finish({ stdout: empty, stderr: empty, truncated: false });
      else fail(error);
    });
    req.end(payload);
  });
