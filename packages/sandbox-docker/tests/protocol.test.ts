import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "node:net";

import { describe, expect, it } from "vitest";

import { commandBaseName, resolveWorkspacePath } from "../src/paths.js";
import { packTar, stripTarRoot, unpackTar } from "../src/tar.js";
import { decodeCappedText, encodeDockerStreamFrame, readMultiplexedStream } from "../src/stream.js";
import { isPrivateAddress, startAllowlistProxy } from "../src/network.js";
import { createFileSandboxLeaseStore, createFileSandboxSnapshotStore, createMemorySandboxLeaseStore, createMemorySandboxSnapshotStore } from "../src/stores.js";
import { createServer } from "node:net";


describe("sandbox path confinement", () => {
  it("keeps relative and absolute paths inside /workspace", () => {
    expect(resolveWorkspacePath("/workspace", "src/main.ts")).toBe("/workspace/src/main.ts");
    expect(resolveWorkspacePath("/workspace", "/workspace/src/main.ts")).toBe("/workspace/src/main.ts");
    expect(resolveWorkspacePath("/workspace", ".")).toBe("/workspace");
    expect(commandBaseName("/bin/echo")).toBe("echo");
    expect(commandBaseName("echo")).toBe("echo");
  });

  it("rejects escapes, symlinks in the path, and executables outside /bin", () => {
    expect(() => resolveWorkspacePath("/workspace", "../etc/passwd")).toThrow(/cannot contain '\.\.'/);
    expect(() => resolveWorkspacePath("/workspace", "/etc/passwd")).toThrow(/outside the workspace/);
    expect(() => resolveWorkspacePath("/tmp", "file")).toThrow(/workspace root/);
    expect(() => commandBaseName("/workspace/evil")).toThrow(/\/bin/);
    expect(() => commandBaseName("../bin/echo")).toThrow(/command/i);
  });
});

describe("sandbox tar and docker stream framing", () => {
  it("round-trips files and strips the workspace root entry", () => {
    const packed = packTar([
      { path: "workspace", type: "directory" },
      { path: "workspace/hello.txt", type: "file", content: new TextEncoder().encode("hello") },
      { path: "workspace/link", type: "symlink", linkTarget: "hello.txt" }
    ]);
    const entries = stripTarRoot(unpackTar(packed), "workspace");
    expect(entries.map(entry => entry.path)).toEqual(["hello.txt", "link"]);
    expect(new TextDecoder().decode(entries[0]?.content)).toBe("hello");
    expect(entries[1]?.linkTarget).toBe("hello.txt");
  });

  it("stores paths of 100 bytes or more with a ustar prefix or a pax header", () => {
    const prefixed = `${"a".repeat(40)}/${"b".repeat(80)}`;
    const extended = `${"c".repeat(180)}/${"d".repeat(90)}`;
    const limit = "e".repeat(4096);
    const packed = packTar([
      { path: "n".repeat(100), type: "file", content: new TextEncoder().encode("short") },
      { path: prefixed, type: "file", content: new TextEncoder().encode("prefix") },
      { path: extended, type: "file", content: new TextEncoder().encode("pax") },
      { path: limit, type: "file", content: new TextEncoder().encode("max") }
    ]);
    const entries = unpackTar(packed);
    expect(entries.map(entry => entry.path)).toEqual(["n".repeat(100), prefixed, extended, limit]);
    expect(entries.map(entry => new TextDecoder().decode(entry.content))).toEqual(["short", "prefix", "pax", "max"]);
    expect(packed.includes(0)).toBe(true);
    expect(() => packTar([{ path: "f".repeat(4097), type: "file" }])).toThrow(/4096/);
  });

  it("caps stdout and stderr independently across split frames", async () => {
    const frames = [
      encodeDockerStreamFrame(1, new TextEncoder().encode("abcdef")),
      encodeDockerStreamFrame(2, new TextEncoder().encode("xyz"))
    ];
    const bytes = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
    let offset = 0;
    for (const frame of frames) {
      bytes.set(frame, offset);
      offset += frame.length;
    }
    const result = await readMultiplexedStream((async function* () {
      yield bytes.subarray(0, 5);
      yield bytes.subarray(5);
    })(), 4);
    expect(new TextDecoder().decode(result.stdout)).toBe("abcd");
    expect(new TextDecoder().decode(result.stderr)).toBe("xyz");
    expect(result.truncated).toBe(true);
    expect(decodeCappedText(new TextEncoder().encode("abcdef"), 3)).toEqual({ text: "abc", truncated: true });
  });
});

describe("sandbox network allowlist", () => {
  it("classifies private and special addresses numerically", () => {
    const cases: Array<[string, boolean]> = [
      ["127.0.0.1", true],
      ["10.1.2.3", true],
      ["172.16.0.1", true],
      ["192.168.1.1", true],
      ["169.254.169.254", true],
      ["198.51.100.10", true],
      ["203.0.113.10", true],
      ["0.0.0.0", true],
      ["::", true],
      ["::1", true],
      ["[::1]", true],
      ["fe80::1", true],
      ["fe80::1%eth0", true],
      ["fe90::1", true],
      ["febf::1", true],
      ["fec0::1", true],
      ["fc00::1", true],
      ["fd00::1", true],
      ["ff02::1", true],
      ["::ffff:127.0.0.1", true],
      ["::ffff:7f00:1", true],
      ["::ffff:a9fe:a9fe", true],
      ["::7f00:1", true],
      ["64:ff9b::7f00:1", true],
      ["64:ff9b::a00:1", true],
      ["64:ff9b:1::7f00:1", true],
      ["2002:7f00:1::", true],
      ["2001:db8::1", true],
      ["2001:0db8:0::1", true],
      ["100::1", true],
      ["2001:2::1", true],
      ["not-an-ip", true],
      ["1.1.1.1", false],
      ["172.32.0.1", false],
      ["8.8.8.8", false],
      ["::ffff:8.8.8.8", false],
      ["::ffff:0808:0808", false],
      ["64:ff9b::808:808", false],
      ["2001:4860:4860::8888", false]
    ];
    for (const [address, expected] of cases) {
      expect(isPrivateAddress(address), address).toBe(expected);
    }
  });

  it("refuses private targets and allows an explicit private test host", async () => {
    const denied = await startAllowlistProxy({
      policy: { allowedDomains: ["example.test"], allowedPorts: [9] },
      resolveHost: async () => ["127.0.0.1"]
    });
    expect(await connectStatus(denied.port, "example.test", 9)).toBe(403);
    let lookups = 0;
    const rebound = await startAllowlistProxy({
      policy: { allowedDomains: ["example.test"], allowedPorts: [9] },
      resolveHost: async () => {
        lookups += 1;
        return lookups === 1 ? ["1.1.1.1"] : ["127.0.0.1"];
      }
    });
    expect(await connectStatus(rebound.port, "example.test", 9)).toBe(403);
    await rebound.close();
    const plain = await fetch(`http://127.0.0.1:${denied.port}/`);
    expect(plain.status).toBe(405);
    await denied.close();

    const target = createServer(socket => socket.end("ok"));
    await new Promise<void>(resolve => target.listen(0, "127.0.0.1", () => resolve()));
    const port = (target.address() as { port: number }).port;
    const allowed = await startAllowlistProxy({
      policy: { allowedDomains: ["example.test"], allowedPorts: [port], allowPrivateNetworks: true },
      resolveHost: async () => ["127.0.0.1"]
    });
    expect(await connectStatus(allowed.port, "evil.test", port)).toBe(403);
    expect(await connectStatus(allowed.port, "example.test", port)).toBe(200);
    await allowed.close();
    await new Promise<void>(resolve => target.close(() => resolve()));
  });

  it("fails closed when connection, in-flight, request, or byte quotas are exhausted", async () => {
    const target = createServer(socket => {
      socket.on("data", () => undefined);
    });
    await new Promise<void>(resolve => target.listen(0, "127.0.0.1", () => resolve()));
    const port = (target.address() as { port: number }).port;
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    let activeLookups = 0;
    let maxActiveLookups = 0;
    const limited = await startAllowlistProxy({
      quotas: { maxConnections: 4, maxInFlight: 1, maxRequests: 8, maxBytes: 32, idleMs: 1_000, tunnelMs: 1_000 },
      policy: { allowedDomains: ["example.test"], allowedPorts: [port], allowPrivateNetworks: true },
      resolveHost: async () => {
        activeLookups += 1;
        maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
        await gate;
        activeLookups -= 1;
        return ["127.0.0.1"];
      }
    });
    try {
      const first = connectStatus(limited.port, "example.test", port);
      await delay(40);
      const second = connectStatus(limited.port, "example.test", port);
      await delay(40);
      expect(maxActiveLookups).toBe(1);
      releaseGate();
      expect(await second).toBe(403);
      expect(await first).toBe(200);
    } finally {
      releaseGate();
      await limited.close();
    }

    const once = await startAllowlistProxy({
      quotas: { maxConnections: 4, maxInFlight: 2, maxRequests: 1, maxBytes: 1_000, idleMs: 1_000, tunnelMs: 1_000 },
      policy: { allowedDomains: ["example.test"], allowedPorts: [port], allowPrivateNetworks: true },
      resolveHost: async () => ["127.0.0.1"]
    });
    expect(await connectStatus(once.port, "example.test", port)).toBe(200);
    expect(await connectStatus(once.port, "example.test", port)).toBe(403);
    await once.close();

    let hold: () => void = () => undefined;
    const held = new Promise<string[]>(resolve => {
      hold = () => resolve(["127.0.0.1"]);
    });
    const single = await startAllowlistProxy({
      quotas: { maxConnections: 1, maxInFlight: 2, maxRequests: 8, maxBytes: 1_000, idleMs: 5_000, tunnelMs: 5_000 },
      policy: { allowedDomains: ["example.test"], allowedPorts: [port], allowPrivateNetworks: true },
      resolveHost: () => held
    });
    const pending = connectStatus(single.port, "example.test", port);
    await delay(40);
    expect(await connectStatus(single.port, "example.test", port)).toBe(403);
    hold();
    await pending;
    await single.close();

    const tiny = await startAllowlistProxy({
      quotas: { maxConnections: 4, maxInFlight: 2, maxRequests: 8, maxBytes: 16, idleMs: 80, tunnelMs: 5_000 },
      policy: { allowedDomains: ["example.test"], allowedPorts: [port], allowPrivateNetworks: true },
      resolveHost: async () => ["127.0.0.1"]
    });
    const flooded = await Promise.race([
      writeUntilClose(tiny.port, port),
      delay(500).then(() => -1)
    ]);
    expect(flooded).toBe(200);
    expect(await connectStatus(tiny.port, "example.test", port)).toBe(403);
    await tiny.close();

    const idleProxy = await startAllowlistProxy({
      quotas: { maxConnections: 2, maxInFlight: 2, maxRequests: 4, maxBytes: 1_000, idleMs: 80, tunnelMs: 5_000 },
      policy: { allowedDomains: ["example.test"], allowedPorts: [port], allowPrivateNetworks: true },
      resolveHost: async () => ["127.0.0.1"]
    });
    const idle = await Promise.race([
      holdUntilClose(idleProxy.port, port),
      delay(500).then(() => "still-open")
    ]);
    expect(idle).toBe("closed");
    await idleProxy.close();
    expect(await connectStatus(idleProxy.port, "example.test", port)).toBe(0);
    await new Promise<void>(resolve => target.close(() => resolve()));
  });
});

describe("sandbox file stores", () => {
  it("persists leases and snapshots as private files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "zhivex-sandbox-"));
    try {
      const leases = createFileSandboxLeaseStore(path.join(directory, "leases"));
      const snapshots = createFileSandboxSnapshotStore(path.join(directory, "snapshots"));
      await leases.compareAndSwap({
        schemaVersion: 1,
        runId: "run/1",
        scopeKey: JSON.stringify(["tenant", "", ""]),
        environmentId: "docker-sandbox",
        fingerprint: "sha256:abc",
        containerId: "container",
        revision: 0,
        status: "active",
        createdAt: 1,
        expiresAt: 2
      }, undefined);
      await expect(leases.compareAndSwap({
        schemaVersion: 1,
        runId: "run/1",
        scopeKey: JSON.stringify(["tenant", "", ""]),
        environmentId: "docker-sandbox",
        fingerprint: "sha256:abc",
        containerId: "container",
        revision: 0,
        status: "active",
        createdAt: 1,
        expiresAt: 2
      }, undefined)).rejects.toThrow(/changed/);
      const snapshot = {
        schemaVersion: 1 as const,
        id: "snap",
        runId: "run/1",
        scopeKey: JSON.stringify(["tenant", "", ""]),
        mode: "workspace-tar" as const,
        workspaceTar: new TextEncoder().encode("tar"),
        createdAt: 1
      };
      await snapshots.save(snapshot);
      const loaded = await snapshots.load("run/1", snapshot.scopeKey);
      expect(new TextDecoder().decode(loaded?.workspaceTar ?? new Uint8Array())).toBe("tar");
      const leaseFile = await findFile(path.join(directory, "leases"), ".json");
      expect((await stat(leaseFile)).mode & 0o777).toBe(0o600);
      expect((await leases.list()).map(lease => lease.runId)).toEqual(["run/1"]);
      await snapshots.remove("run/1", snapshot.scopeKey);
      expect(await snapshots.load("run/1", snapshot.scopeKey)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets one of two concurrent creates win the file lease", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "zhivex-sandbox-race-"));
    try {
      const leases = createFileSandboxLeaseStore(directory);
      const scopeKey = JSON.stringify(["tenant", "", ""]);
      const draft = (containerId: string) => ({
        schemaVersion: 1 as const,
        runId: "run/1",
        scopeKey,
        environmentId: "docker-sandbox",
        fingerprint: "sha256:abc",
        containerId,
        revision: 0,
        status: "active" as const,
        createdAt: 1,
        expiresAt: 2
      });
      const results = await Promise.allSettled([
        leases.compareAndSwap(draft("container-a"), undefined),
        leases.compareAndSwap(draft("container-b"), undefined)
      ]);
      const saved = results.filter(result => result.status === "fulfilled");
      expect(saved).toHaveLength(1);
      const stored = await leases.load("run/1", scopeKey);
      expect(stored?.containerId).toBe(saved[0] && saved[0].status === "fulfilled" ? saved[0].value.containerId : "");
      expect(stored?.revision).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces a dead or stale lock and refuses a live owner's lock", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "zhivex-sandbox-lock-"));
    try {
      const scopeKey = JSON.stringify(["tenant", "", ""]);
      const scopeDir = createHash("sha256").update(scopeKey).digest("hex");
      const lockPath = path.join(directory, scopeDir, `${encodeURIComponent("run/1")}.json.lock`);
      await mkdir(path.dirname(lockPath), { recursive: true });
      const leases = createFileSandboxLeaseStore(directory);
      const draft = {
        schemaVersion: 1 as const,
        runId: "run/1",
        scopeKey,
        environmentId: "docker-sandbox",
        fingerprint: "sha256:abc",
        containerId: "container",
        revision: 0,
        status: "active" as const,
        createdAt: 1,
        expiresAt: 2
      };
      await writeFile(lockPath, JSON.stringify({ ownerId: "dead", pid: 2_147_483_646, createdAt: 1 }), { mode: 0o600 });
      await expect(leases.compareAndSwap(draft, undefined)).resolves.toMatchObject({ containerId: "container" });
      const other = createFileSandboxLeaseStore(path.join(directory, "other"));
      const otherScope = JSON.stringify(["other", "", ""]);
      const otherDir = createHash("sha256").update(otherScope).digest("hex");
      const otherLock = path.join(directory, "other", otherDir, `${encodeURIComponent("run/2")}.json.lock`);
      await mkdir(path.dirname(otherLock), { recursive: true });
      await writeFile(otherLock, "not-json", { mode: 0o600 });
      const old = new Date(Date.now() - 60_000);
      await utimes(otherLock, old, old);
      await expect(other.compareAndSwap({ ...draft, runId: "run/2", scopeKey: otherScope }, undefined)).resolves.toMatchObject({ runId: "run/2" });
      const liveLock = path.join(directory, scopeDir, `${encodeURIComponent("run/live")}.json.lock`);
      await writeFile(liveLock, JSON.stringify({ ownerId: "live", pid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
      await expect(leases.compareAndSwap({ ...draft, runId: "run/live" }, undefined)).rejects.toThrow(/file lock/);
      await expect(leases.compareAndSwap({ ...draft, runId: ".." }, undefined)).rejects.toThrow(/cannot be '\.' or '\.\.'/);
      await expect(leases.compareAndSwap({ ...draft, runId: "." }, undefined)).rejects.toThrow(/cannot be '\.' or '\.\.'/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects '.' and '..' snapshot run ids and mismatched snapshot metadata", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "zhivex-sandbox-escape-"));
    try {
      const snapshots = createFileSandboxSnapshotStore(path.join(directory, "snapshots"));
      const scopeA = JSON.stringify(["tenant-a", "", ""]);
      const scopeB = JSON.stringify(["tenant-b", "", ""]);
      const snapshot = {
        schemaVersion: 1 as const,
        id: "snap",
        runId: "kept",
        scopeKey: scopeA,
        mode: "workspace-tar" as const,
        workspaceTar: new TextEncoder().encode("tar"),
        createdAt: 1
      };
      await snapshots.save(snapshot);
      await expect(snapshots.save({ ...snapshot, runId: "..", scopeKey: scopeB })).rejects.toThrow(/cannot be '\.' or '\.\.'/);
      await expect(snapshots.save({ ...snapshot, runId: ".", scopeKey: scopeB })).rejects.toThrow(/cannot be '\.' or '\.\.'/);
      const memory = createMemorySandboxSnapshotStore();
      await expect(memory.save({ ...snapshot, runId: ".." })).rejects.toThrow(/cannot be '\.' or '\.\.'/);
      await snapshots.save({ ...snapshot, runId: "..run", scopeKey: scopeB });
      expect((await snapshots.load("..run", scopeB))?.runId).toBe("..run");
      await memory.save({ ...snapshot, runId: "..run" });
      expect((await memory.load("..run", scopeA))?.runId).toBe("..run");
      const scopeDir = createHash("sha256").update(scopeB).digest("hex");
      const savedPath = path.join(directory, "snapshots", scopeDir, `${encodeURIComponent("..run")}.json`);
      expect(path.relative(path.join(directory, "snapshots", scopeDir), savedPath).split(path.sep)).not.toContain("..");
      const lease = {
        schemaVersion: 1 as const,
        runId: "..run",
        scopeKey: scopeB,
        environmentId: "docker-sandbox",
        fingerprint: "sha256:abc",
        containerId: "container",
        revision: 0,
        status: "active" as const,
        createdAt: 1,
        expiresAt: 2
      };
      const fileLeases = createFileSandboxLeaseStore(path.join(directory, "leases"));
      const memoryLeases = createMemorySandboxLeaseStore();
      await fileLeases.compareAndSwap(lease, undefined);
      await memoryLeases.compareAndSwap(lease, undefined);
      expect((await fileLeases.load("..run", scopeB))?.containerId).toBe("container");
      expect((await memoryLeases.load("..run", scopeB))?.containerId).toBe("container");
      await expect(fileLeases.compareAndSwap({ ...lease, runId: ".." }, undefined)).rejects.toThrow(/cannot be '\.' or '\.\.'/);
      await expect(memoryLeases.compareAndSwap({ ...lease, runId: "." }, undefined)).rejects.toThrow(/cannot be '\.' or '\.\.'/);
      expect(new TextDecoder().decode((await snapshots.load("kept", scopeA))?.workspaceTar ?? new Uint8Array())).toBe("tar");
      const keptScope = createHash("sha256").update(scopeA).digest("hex");
      const file = path.join(directory, "snapshots", keptScope, `${encodeURIComponent("kept")}.json`);
      const raw = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8")) as { runId: string };
      raw.runId = "other";
      await writeFile(file, JSON.stringify(raw));
      await expect(snapshots.load("kept", scopeA)).rejects.toThrow(/identity/);
      expect(await snapshots.load("kept", scopeB)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const writeUntilClose = (port: number, targetPort: number) => new Promise<number>(resolve => {
  const socket = connect(port, "127.0.0.1");
  let response = "";
  let settled = false;
  const finish = (status: number) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(status);
  };
  socket.on("data", chunk => {
    response += chunk.toString("utf8");
    const status = /^HTTP\/1\.1 (\d+)/.exec(response);
    if (status?.[1] === "200") socket.write("y".repeat(200));
    else if (status?.[1]) finish(Number(status[1]));
  });
  socket.on("close", () => finish(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1] === "200" ? 200 : 0));
  socket.on("error", () => finish(0));
  socket.write(`CONNECT example.test:${targetPort} HTTP/1.1\r\nHost: example.test:${targetPort}\r\n\r\n`);
});

const holdUntilClose = (port: number, targetPort: number) => new Promise<string>(resolve => {
  const socket = connect(port, "127.0.0.1");
  let response = "";
  socket.on("data", chunk => {
    response += chunk.toString("utf8");
  });
  socket.on("close", () => resolve(response.includes("200") ? "closed" : "denied"));
  socket.on("error", () => resolve(response.includes("200") ? "closed" : "denied"));
  socket.write(`CONNECT example.test:${targetPort} HTTP/1.1\r\nHost: example.test:${targetPort}\r\n\r\n`);
});

const connectStatus = (port: number, host: string, targetPort: number) => new Promise<number>(resolve => {
  const socket = connect(port, "127.0.0.1");
  let response = "";
  let settled = false;
  const finish = (status: number) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(status);
  };
  socket.on("data", chunk => {
    response += chunk.toString("utf8");
    const status = /^HTTP\/1\.1 (\d+)/.exec(response);
    if (status?.[1]) finish(Number(status[1]));
  });
  socket.on("close", () => finish(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1] ? Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1]) : 0));
  socket.on("error", () => finish(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1] ? Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1]) : 0));
  socket.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n\r\n`);
});

const findFile = async (directory: string, suffix: string): Promise<string> => {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(directory, { recursive: true })) {
    if (entry.endsWith(suffix)) return path.join(directory, entry);
  }
  throw new Error(`Missing ${suffix} under ${directory}`);
};
