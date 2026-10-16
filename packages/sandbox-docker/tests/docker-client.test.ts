import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createNodeDockerClient } from "../src/docker-client.js";
import { createDockerSandboxEnvironment } from "../src/environment.js";
import { encodeDockerStreamFrame } from "../src/stream.js";
import { packTar, unpackTar } from "../src/tar.js";

const readBody = (request: IncomingMessage) => new Promise<Buffer>(resolve => {
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(Buffer.from(chunk)));
  request.on("end", () => resolve(Buffer.concat(chunks)));
});

describe("node docker client", () => {
  it("sends the secure host config and demultiplexes exec output", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "zhivex-docker-sock-"));
    const socketPath = path.join(directory, "docker.sock");
    const created: unknown[] = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://docker");
      const body = await readBody(request);
      if (request.method === "GET" && url.pathname === "/version") {
        return json(response, 200, { ApiVersion: "1.43", MinAPIVersion: "1.24" });
      }
      if (request.method === "POST" && url.pathname.endsWith("/containers/create")) {
        created.push(JSON.parse(body.toString("utf8")));
        return json(response, 201, { Id: "container-1" });
      }
      if (request.method === "POST" && url.pathname.endsWith("/containers/container-1/start")) return json(response, 204, undefined);
      if (request.method === "PUT" && url.pathname.endsWith("/archive")) return json(response, 200, undefined);
      if (request.method === "POST" && url.pathname.endsWith("/containers/container-1/exec")) {
        return json(response, 201, { Id: "exec-1" });
      }
      if (request.method === "POST" && url.pathname.endsWith("/exec/exec-1/start")) {
        response.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
        response.end(Buffer.concat([
          Buffer.from(encodeDockerStreamFrame(1, Buffer.from("ok"))),
          Buffer.from(encodeDockerStreamFrame(2, Buffer.from("warn")))
        ]));
        return;
      }
      if (request.method === "GET" && url.pathname.endsWith("/exec/exec-1/json")) {
        return json(response, 200, { ExitCode: 0, Running: false });
      }
      if (request.method === "DELETE") return json(response, 204, undefined);
      return json(response, 500, { message: `unexpected ${request.method} ${url.pathname}` });
    });
    await new Promise<void>(resolve => server.listen(socketPath, () => resolve()));
    try {
      const docker = createNodeDockerClient({ socketPath });
      const sandbox = createDockerSandboxEnvironment({
        docker,
        workspace: { id: "workspace-1", files: [{ path: "README.md", contents: "hello" }] }
      });
      const session = await sandbox.acquire({ runId: "run-protocol" });
      expect(created[0]).toMatchObject({
        Image: "alpine:3.21",
        User: "65534:65534",
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Init: true,
          Memory: 256 * 1024 * 1024,
          MemorySwap: 256 * 1024 * 1024,
          PidsLimit: 64
        }
      });
      expect(JSON.stringify(created[0])).not.toContain("Binds");
      expect(JSON.stringify(created[0])).not.toContain("Privileged");
      const exec = await docker.exec(session.containerId, {
        cmd: ["/bin/echo", "ok"],
        user: "65534:65534",
        workingDir: "/workspace",
        timeoutMs: 1_000,
        maxOutputBytes: 100
      });
      expect(new TextDecoder().decode(exec.stdout)).toBe("ok");
      expect(new TextDecoder().decode(exec.stderr)).toBe("warn");
      expect(exec.exitCode).toBe(0);
      await session.release({ status: "failed" });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("surfaces API failures and stops a capped command", async () => {
    await expect(createNodeDockerClient({ socketPath: "/tmp/zhivex-missing-docker.sock" }).inspectContainer("missing"))
      .rejects.toThrow(/not available/);
    const directory = await mkdtemp(path.join(tmpdir(), "zhivex-docker-sock-"));
    const socketPath = path.join(directory, "docker.sock");
    let execs = 0;
    const commands = new Map<string, string[]>();
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://docker");
      const body = await readBody(request);
      if (request.method === "GET" && url.pathname === "/version") {
        return json(response, 200, { ApiVersion: "1.43", MinAPIVersion: "1.24" });
      }
      if (request.method === "GET" && url.pathname.endsWith("/containers/missing/json")) {
        return json(response, 404, { message: "no such container" });
      }
      if (request.method === "GET" && url.pathname.endsWith("/containers/c/json")) {
        return json(response, 200, { Id: "c", State: { Running: true, Status: "running", OOMKilled: false, ExitCode: 0 } });
      }
      if (request.method === "GET" && url.pathname.endsWith("/containers/json")) {
        return json(response, 200, [{ Id: "c", Labels: { "zhivex.sandbox": "1" } }]);
      }
      if (request.method === "POST" && url.pathname.endsWith("/kill")) return json(response, 204, undefined);
      if (request.method === "GET" && url.pathname.endsWith("/top")) {
        return json(response, 200, { Titles: ["PID", "CMD"], Processes: [["42", "sleep zhivex_marker"]] });
      }
      if (request.method === "GET" && url.pathname.includes("/archive")) {
        if (url.searchParams.get("path") === "/missing") return json(response, 404, { message: "missing" });
        const stat = Buffer.from(JSON.stringify({ name: "note.txt", size: 4, mode: 0o644, linkTarget: "" })).toString("base64");
        response.writeHead(200, { "x-docker-container-path-stat": stat });
        response.end(Buffer.from("tar"));
        return;
      }
      if (request.method === "PUT" && url.pathname.includes("/archive")) {
        if (url.searchParams.get("path") === "/workspace") {
          return json(response, 500, { message: "container rootfs is marked read-only" });
        }
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end("not-json");
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1.43/commit") return json(response, 201, { Id: "sha256:abc" });
      if (request.method === "POST" && url.pathname.endsWith("/networks/create")) return json(response, 201, { Id: "net1" });
      if (request.method === "GET" && url.pathname.endsWith("/networks/net1")) {
        return json(response, 200, { IPAM: { Config: [{ Gateway: "172.18.0.1" }] } });
      }
      if (request.method === "DELETE" && url.pathname.endsWith("/networks/net1")) return json(response, 204, undefined);
      if (request.method === "POST" && url.pathname.endsWith("/exec")) {
        const command = JSON.parse(body.toString("utf8")) as { Cmd?: string[] };
        const cmd = command.Cmd ?? [];
        if (cmd.includes("fail-please")) return json(response, 201, { Id: "exec-fail" });
        const id = cmd[0] === "/bin/tar" && cmd.includes("-x") ? "exec-tar" : `exec-${execs += 1}`;
        commands.set(id, cmd);
        return json(response, 201, { Id: id });
      }
      if (request.method === "POST" && url.pathname.includes("/exec/") && url.pathname.endsWith("/start")) {
        if (url.pathname.includes("exec-fail")) {
          return json(response, 500, { message: "exec failed" });
        }
        const id = url.pathname.split("/").at(-2) ?? "";
        const cmd = commands.get(id) ?? [];
        const payload = cmd[0] === "/bin/tar" && cmd.includes("-c")
          ? Buffer.from(packTar([{ path: "note.txt", type: "file", content: Buffer.from("note"), mode: 0o644 }]))
          : Buffer.from("abcdef");
        response.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
        response.end(Buffer.from(encodeDockerStreamFrame(1, payload)));
        return;
      }
      if (request.method === "GET" && url.pathname.includes("/exec/") && url.pathname.endsWith("/json")) {
        const id = url.pathname.split("/").at(-2) ?? "";
        const missing = commands.get(id)?.includes("missing") === true;
        return json(response, 200, { ExitCode: missing ? 1 : 0, Running: false });
      }
      return json(response, 500, { message: `unexpected ${request.method} ${url.pathname}` });
    });
    await new Promise<void>(resolve => server.listen(socketPath, () => resolve()));
    try {
      const docker = createNodeDockerClient({ socketPath });
      expect((await docker.inspectContainer("c")).State.Running).toBe(true);
      await expect(docker.inspectContainer("missing")).rejects.toThrow(/no such container/);
      expect(await docker.listContainers("zhivex.sandbox=1")).toEqual([{ Id: "c", Labels: { "zhivex.sandbox": "1" } }]);
      await docker.killContainer("c");
      const archived = await docker.getArchive("c", "/workspace/note.txt");
      expect(archived.stat.name).toBe("note.txt");
      expect(unpackTar(archived.tar).find(entry => entry.path === "note.txt")?.type).toBe("file");
      await expect(docker.getArchive("c", "/missing")).rejects.toThrow(/not found/i);
      await expect(docker.putArchive("c", "/etc", new Uint8Array([1]))).rejects.toThrow(/not-json/);
      expect((await docker.commitContainer("c", "zhivex-sandbox", "snap")).Id).toBe("sha256:abc");
      const network = await docker.createNetwork("zhivex");
      expect(network).toEqual({ Id: "net1", gateway: "172.18.0.1" });
      await docker.removeNetwork(network.Id);
      const capped = await docker.exec("c", {
        cmd: ["/bin/echo", "abcdef"],
        user: "65534:65534",
        workingDir: "/workspace",
        timeoutMs: 1_000,
        maxOutputBytes: 2,
        marker: "zhivex_marker"
      });
      expect(capped.truncated).toBe(true);
      expect(new TextDecoder().decode(capped.stdout)).toBe("ab");
      await expect(docker.exec("c", {
        cmd: ["/bin/echo", "fail-please"],
        user: "65534:65534",
        workingDir: "/workspace",
        timeoutMs: 1_000,
        maxOutputBytes: 10,
        marker: "exec-fail"
      })).rejects.toThrow(/exec failed/);
      const controller = new AbortController();
      controller.abort();
      await expect(docker.exec("c", {
        cmd: ["/bin/echo", "late"],
        user: "65534:65534",
        workingDir: "/workspace",
        timeoutMs: 1_000,
        maxOutputBytes: 10,
        signal: controller.signal
      })).rejects.toThrow(/cancelled/);
      const tar = new Uint8Array([1, 2, 3, 4]);
      const extracted: Buffer[] = [];
      server.on("upgrade", (upgradeRequest, socket) => {
        const upgradeUrl = new URL(upgradeRequest.url ?? "/", "http://docker");
        if (!upgradeUrl.pathname.endsWith("/exec/exec-tar/start")) {
          socket.end();
          return;
        }
        socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
        socket.on("data", chunk => extracted.push(Buffer.from(chunk)));
        socket.on("end", () => socket.end());
      });
      await docker.putArchive("c", "/workspace", tar);
      expect(Buffer.concat(extracted)).toEqual(Buffer.from(tar));
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const json = (response: ServerResponse, status: number, body: unknown) => {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  response.writeHead(status, payload.length ? { "Content-Type": "application/json", "Content-Length": payload.length } : undefined);
  response.end(payload);
};
