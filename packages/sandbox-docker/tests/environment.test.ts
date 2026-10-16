import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Agent, ConflictError, createMockLanguageModel, createTextMessage } from "@zhivex-ai/core";
import { describe, expect, it } from "vitest";

import { createDockerSandboxEnvironment, createDockerSandboxTools } from "../src/index.js";
import { createMemoryDockerClient } from "../src/memory-docker-client.js";
import { createFileSandboxLeaseStore, createMemorySandboxLeaseStore, createMemorySandboxSnapshotStore } from "../src/stores.js";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const environment = (overrides: Parameters<typeof createDockerSandboxEnvironment>[0]["workspace"] extends infer _T ? Partial<Parameters<typeof createDockerSandboxEnvironment>[0]> : never = {}) => {
  const docker = overrides.docker ?? createMemoryDockerClient();
  const sandbox = createDockerSandboxEnvironment({
    docker,
    assurance: "best-effort",
    workspace: { id: "workspace-1", files: [{ path: "README.md", contents: "hello\n" }], directories: ["src"] },
    ...overrides
  });
  return { docker: docker as ReturnType<typeof createMemoryDockerClient>, sandbox };
};

describe("docker sandbox environment", () => {
  it("boots a non-root, offline, bounded container and confines the workspace", async () => {
    const { docker, sandbox } = environment({
      shell: { allow: ["echo", "id", "sleep"] },
      limits: { maxProcessOutputBytes: 4, memoryMb: 128, cpus: 0.25, pidsLimit: 32 }
    });
    expect(sandbox.manifest.assurance).toBe("best-effort");
    expect(sandbox.manifest.permissions?.network).toEqual({ mode: "deny" });
    expect(sandbox.manifest.permissions?.process).toEqual({ shell: "allowlist", allowedCommands: ["echo", "id", "sleep"] });
    const session = await sandbox.acquire({ runId: "run-secure" });
    const spec = docker.specs()[0];
    expect(spec).toMatchObject({
      user: "65534:65534",
      networkMode: "none",
      readonlyRootfs: true,
      memoryBytes: 128 * 1024 * 1024,
      nanoCpus: 250_000_000,
      pidsLimit: 32,
      init: true
    });
    expect(spec?.env.join("\n")).not.toContain("HTTP_PROXY");
    expect(JSON.stringify(spec)).not.toContain("Binds");
    expect(text(await session.readFile("README.md"))).toBe("hello\n");
    await session.writeFile("src/note.txt", "note");
    expect(await session.list(".")).toEqual(["README.md", "src"]);
    expect(text(await session.readFile("src/note.txt"))).toBe("note");
    await expect(session.readFile("../etc/passwd")).rejects.toThrow(/cannot contain '\.\.'/);
    await expect(session.exec(["/bin/sh", "-c", "echo owned"])).rejects.toThrow(/not on the sandbox allowlist/);
    const capped = await session.exec(["/bin/echo", "abcdef"]);
    expect(capped.stdout).toBe("abcd");
    expect(capped.truncated).toBe(true);
    expect((await session.exec(["/bin/sleep", "30"], { timeoutMs: 1000 })).timedOut).toBe(true);
    expect(session.authorize({
      manifest: session.manifest,
      binding: session.binding,
      tool: { name: "calculator" } as never,
      toolCall: { id: "call", name: "calculator", input: {} },
      input: {},
      context: {} as never,
      phase: "preflight"
    }).decision).toBe("deny");
    await session.release({ status: "completed" });
    expect(docker.containerIds()).toEqual([]);
    await expect(sandbox.acquire({ runId: "run-secure" })).rejects.toThrow(/released/);
  });

  it("reattaches a paused run and restores a lost container from the workspace snapshot", async () => {
    const docker = createMemoryDockerClient();
    const leases = createMemorySandboxLeaseStore();
    const sandbox = createDockerSandboxEnvironment({
      docker,
      leases,
      assurance: "best-effort",
      snapshot: "docker-commit",
      shell: "deny",
      workspace: { id: "workspace-1", files: [{ path: "README.md", contents: "v1" }] }
    });
    const first = await sandbox.acquire({ runId: "run-resume", scope: { tenantId: "acme" } });
    await first.writeFile("README.md", "v2");
    const containerId = first.containerId;
    const shot = await first.snapshot();
    expect(shot.mode).toBe("docker-commit");
    expect(shot.id).toMatch(/^snap_/);
    await first.release({ status: "waiting_approval" });
    const second = await sandbox.acquire({ runId: "run-resume", scope: { tenantId: "acme" } });
    expect(second.containerId).toBe(containerId);
    expect(text(await second.readFile("README.md"))).toBe("v2");
    await second.release({ status: "waiting_approval" });
    await docker.removeContainer(containerId);
    const restored = await sandbox.acquire({ runId: "run-resume", scope: { tenantId: "acme" } });
    expect(restored.containerId).not.toBe(containerId);
    expect(text(await restored.readFile("README.md"))).toBe("v2");
    await expect(sandbox.acquire({
      runId: "run-resume",
      scope: { tenantId: "other" }
    })).resolves.toEqual(expect.objectContaining({ kind: "docker-sandbox" }));
    expect(docker.containerIds()).toHaveLength(2);
    const changed = createDockerSandboxEnvironment({
      docker,
      leases,
      id: "other-environment",
      assurance: "best-effort",
      workspace: { id: "workspace-1" }
    });
    await expect(changed.acquire({ runId: "run-resume", scope: { tenantId: "acme" } })).rejects.toBeInstanceOf(ConflictError);
    await restored.release({ status: "failed" });
  });

  it("expires leases instead of minting a fresh workspace for the same run", async () => {
    let now = 1_000;
    const { docker, sandbox } = environment({ clock: () => now, leaseTtlMs: 50 });
    const session = await sandbox.acquire({ runId: "run-lease" });
    now = 2_000;
    await expect(sandbox.acquire({ runId: "run-lease" })).rejects.toThrow(/expired/);
    expect(docker.containerIds()).not.toContain(session.containerId);
    const { sandbox: sweepable, docker: sweepDocker } = environment({ clock: () => now, leaseTtlMs: 5 });
    const live = await sweepable.acquire({ runId: "run-sweep" });
    now += 10;
    expect((await sweepable.sweep(now)).removedContainerIds).toContain(live.containerId);
    expect(sweepDocker.containerIds()).not.toContain(live.containerId);
  });

  it("rejects unsafe profiles and copies only declared source files", async () => {
    expect(() => environment({ user: "0:0" }).sandbox).toThrow(/non-root/);
    expect(() => environment({ assurance: "enforced" }).sandbox).toThrow(/cannot satisfy assurance/);
    expect(() => environment({
      workspace: { id: "workspace-1", access: "read-only" },
      shell: "allow"
    }).sandbox).toThrow(/read-only/);
    expect(() => environment({
      network: { mode: "allowlist", allowedDomains: ["localhost"], allowedPorts: [443] }
    }).sandbox).toThrow(/public DNS name/);

    const directory = await mkdtemp(path.join(tmpdir(), "zhivex-sandbox-src-"));
    try {
      await writeFile(path.join(directory, "kept.txt"), "kept");
      await symlink("/etc/passwd", path.join(directory, "secret"));
      const { sandbox } = environment({
        workspace: { id: "workspace-1", source: { root: directory, include: ["kept.txt"] } }
      });
      const session = await sandbox.acquire({ runId: "run-source" });
      expect(text(await session.readFile("kept.txt"))).toBe("kept");
      await session.release({ status: "completed" });
      const linked = createDockerSandboxEnvironment({
        docker: createMemoryDockerClient(),
        assurance: "best-effort",
        workspace: { id: "workspace-1", source: { root: directory, include: ["secret"] } }
      });
      await expect(linked.acquire({ runId: "run-link" })).rejects.toThrow(/symlink/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses an internal allowlist network only when domains and ports are declared", async () => {
    const { docker, sandbox } = environment({
      network: { mode: "allowlist", allowedDomains: ["example.com"], allowedPorts: [443] }
    });
    const session = await sandbox.acquire({ runId: "run-net" });
    const spec = docker.specs().at(-1);
    expect(spec?.networkMode).not.toBe("none");
    expect(spec?.networkMode).not.toBe("host");
    expect(spec?.env.some(entry => entry.startsWith("HTTPS_PROXY=http://10.88.0.1:"))).toBe(true);
    await session.release({ status: "completed" });
    expect(docker.removedNetworkIds().length).toBeGreaterThan(0);
  });

  it("drops the previous allowlist network when a resumed process rebuilds the container", async () => {
    const docker = createMemoryDockerClient();
    const leases = createMemorySandboxLeaseStore();
    const snapshots = createMemorySandboxSnapshotStore();
    const options = {
      docker,
      leases,
      snapshots,
      assurance: "best-effort" as const,
      network: { mode: "allowlist" as const, allowedDomains: ["example.com"], allowedPorts: [443] },
      workspace: { id: "workspace-1", files: [{ path: "README.md", contents: "hello\n" }] }
    };
    const first = createDockerSandboxEnvironment(options);
    const session = await first.acquire({ runId: "run-rebuild" });
    const previousNetwork = docker.specs().at(-1)?.networkMode;
    await session.release({ status: "waiting_approval" });
    const second = createDockerSandboxEnvironment(options);
    const resumed = await second.acquire({ runId: "run-rebuild" });
    expect(previousNetwork).toBeTruthy();
    expect(docker.removedNetworkIds()).toContain(previousNetwork);
    expect(docker.specs().at(-1)?.networkMode).not.toBe(previousNetwork);
    await resumed.release({ status: "completed" });
  });

  it("coalesces parallel lease renewals and keeps one container when acquires race", async () => {
    const { sandbox } = environment();
    const session = await sandbox.acquire({ runId: "run-parallel" });
    await expect(Promise.all([
      session.readFile("README.md"),
      session.list("."),
      session.readFile("README.md")
    ])).resolves.toHaveLength(3);
    await session.release({ status: "completed" });

    const directory = await mkdtemp(path.join(tmpdir(), "zhivex-sandbox-acquire-"));
    try {
      const docker = createMemoryDockerClient();
      const racing = createDockerSandboxEnvironment({
        docker,
        leases: createFileSandboxLeaseStore(path.join(directory, "leases")),
        assurance: "best-effort",
        workspace: { id: "workspace-1", files: [{ path: "README.md", contents: "hello\n" }] }
      });
      const results = await Promise.allSettled([
        racing.acquire({ runId: "race" }),
        racing.acquire({ runId: "race" })
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(docker.containerIds()).toHaveLength(1);
      const winner = results.find(result => result.status === "fulfilled");
      if (winner?.status === "fulfilled") await winner.value.release({ status: "completed" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds tool callbacks and remembered images", async () => {
    const { sandbox, docker } = environment({ limits: { maxProcessRuntimeMs: 30 } });
    const session = await sandbox.acquire({ runId: "run-deadline" });
    await expect(session.execute({} as never, () => new Promise(() => undefined))).rejects.toThrow(/deadline/);
    for (let index = 0; index < 40; index += 1) {
      await docker.commitContainer(session.containerId, "zhivex-sandbox", `image-${index}`);
    }
    expect(docker.imageCount()).toBeLessThanOrEqual(32);
    const controller = new AbortController();
    controller.abort();
    await expect(sandbox.acquire({ runId: "run-abort", abortSignal: controller.signal })).rejects.toThrow(/cancelled/);
    await session.release({ status: "completed" });
  });

  it("resumes a durable agent run on the same container", async () => {
    const docker = createMemoryDockerClient();
    const sandbox = createDockerSandboxEnvironment({
      docker,
      assurance: "best-effort",
      shell: { allow: ["echo"] },
      workspace: { id: "workspace-1" }
    });
    const model = createMockLanguageModel({
      responses: [
        {
          finishReason: "tool-calls",
          messages: [{
            role: "assistant",
            parts: [{ type: "tool-call", toolCall: { id: "call-write", name: "sandbox_write_file", input: { path: "note.txt", contents: "saved" } } }]
          }]
        },
        {
          text: "saved",
          finishReason: "stop",
          messages: [createTextMessage("assistant", "saved")]
        }
      ]
    });
    const agent = new Agent({
      id: "sandbox-agent",
      model,
      maxSteps: 3,
      executionEnvironment: sandbox,
      tools: createDockerSandboxTools()
    });
    const waiting = await agent.run({ prompt: "Write the note." });
    expect(waiting.status).toBe("waiting_approval");
    expect(docker.containerIds()).toHaveLength(1);
    const containerId = docker.containerIds()[0];
    const resumed = await agent.resume({
      state: waiting.state,
      approvals: waiting.state.pendingApprovals.map(approval => ({
        provider: approval.provider,
        approvalRequestId: approval.id,
        approve: true
      }))
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.outputText).toBe("saved");
    expect(docker.createdContainerIds()).toEqual([containerId]);
    expect(docker.containerIds()).toEqual([]);
  });

  it("runs the sandbox tools against the acquired session", async () => {
    const { docker, sandbox } = environment({ shell: { allow: ["echo", "cat"] } });
    const session = await sandbox.acquire({ runId: "run-tools" });
    const tools = createDockerSandboxTools();
    const context = { executionEnvironment: session };
    const read = await tools.sandbox_read_file.execute({ path: "README.md" }, context);
    expect(read.text).toBe("hello\n");
    const listed = await tools.sandbox_list.execute({}, context);
    expect(listed.entries).toContain("README.md");
    const wrote = await tools.sandbox_write_file.execute({ path: "src/extra.txt", contents: "extra" }, context);
    expect(wrote.bytes).toBe(5);
    const ran = await tools.sandbox_exec.execute({ argv: ["/bin/cat", "/workspace/README.md"] }, context);
    expect(ran.stdout).toBe("hello\n");
    expect(ran.exitCode).toBe(0);
    await docker.killContainer(session.containerId);
    await expect(tools.sandbox_read_file.execute({ path: "README.md" }, {})).rejects.toThrow(/acquired Docker/);
    await session.release({ status: "completed" });
  });
});
