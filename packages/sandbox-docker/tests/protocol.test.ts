import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "node:net";

import { describe, expect, it } from "vitest";

import { commandBaseName, resolveWorkspacePath } from "../src/paths.js";
import { packTar, stripTarRoot, unpackTar } from "../src/tar.js";
import { decodeCappedText, encodeDockerStreamFrame, readMultiplexedStream } from "../src/stream.js";
import { isPrivateAddress, startAllowlistProxy } from "../src/network.js";
import { createFileSandboxLeaseStore, createFileSandboxSnapshotStore } from "../src/stores.js";
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
  it("classifies private and metadata addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });

  it("refuses private targets and allows an explicit private test host", async () => {
    const denied = await startAllowlistProxy({
      policy: { allowedDomains: ["example.test"], allowedPorts: [9] },
      resolveHost: async () => ["127.0.0.1"]
    });
    expect(await connectStatus(denied.port, "example.test", 9)).toBe(403);
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
});

const connectStatus = (port: number, host: string, targetPort: number) => new Promise<number>(resolve => {
  const socket = connect(port, "127.0.0.1");
  let response = "";
  socket.on("data", chunk => {
    response += chunk.toString("utf8");
    const status = /^HTTP\/1\.1 (\d+)/.exec(response);
    if (status?.[1]) {
      socket.end();
      resolve(Number(status[1]));
    }
  });
  socket.on("error", () => resolve(0));
  socket.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n\r\n`);
});

const findFile = async (directory: string, suffix: string): Promise<string> => {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(directory, { recursive: true })) {
    if (entry.endsWith(suffix)) return path.join(directory, entry);
  }
  throw new Error(`Missing ${suffix} under ${directory}`);
};
