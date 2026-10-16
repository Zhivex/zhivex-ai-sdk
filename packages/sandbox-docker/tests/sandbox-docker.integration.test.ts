import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createDockerSandboxEnvironment } from "../src/index.js";
import { createNodeDockerClient } from "../src/docker-client.js";

const execFileAsync = promisify(execFile);
const required = process.env.ZHIVEX_SANDBOX_DOCKER === "1";

const dockerReady = async () => {
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
};

const ready = await dockerReady();
if (required && !ready) {
  throw new Error("ZHIVEX_SANDBOX_DOCKER=1 but the Docker daemon is not available.");
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe.skipIf(!ready)("docker sandbox integration", () => {
  it("confines a real container, reattaches a paused run, and restores a removed container", async () => {
    const docker = createNodeDockerClient();
    const sandbox = createDockerSandboxEnvironment({
      docker,
      id: "docker-sandbox-integration",
      shell: { allow: ["echo", "id", "ls", "sleep", "touch"] },
      limits: { maxProcessOutputBytes: 32, maxProcessRuntimeMs: 15_000 },
      workspace: {
        id: "workspace-integration",
        files: [{ path: "README.md", contents: "hello\n" }],
        directories: ["src"]
      }
    });
    const runId = `run-integration-${Date.now()}`;
    const first = await sandbox.acquire({ runId });
    let containerId = first.containerId;
    try {
      const uid = await first.exec(["/usr/bin/id", "-u"]);
      expect(uid.exitCode, uid.stderr).toBe(0);
      expect(uid.stdout.trim()).toBe("65534");

      const links = await first.exec(["/bin/ls", "/sys/class/net"]);
      expect(links.exitCode, links.stderr).toBe(0);
      expect(links.stdout.split("\n").filter(Boolean)).toEqual(["lo"]);

      const outside = await first.exec(["/bin/touch", "/etc/sandbox-probe"]);
      expect(outside.exitCode).not.toBe(0);
      const scratch = await first.exec(["/bin/touch", "/tmp/sandbox-probe"]);
      expect(scratch.exitCode, scratch.stderr).toBe(0);

      expect(text(await first.readFile("README.md"))).toBe("hello\n");
      await first.writeFile("src/note.txt", "note");
      expect(await first.list(".")).toEqual(["README.md", "src"]);
      expect(text(await first.readFile("src/note.txt"))).toBe("note");

      const capped = await first.exec(["/bin/echo", "abcdefghijklmnopqrstuvwxyz0123456789"]);
      expect(capped.truncated).toBe(true);
      expect(capped.stdout.length).toBeLessThanOrEqual(32);

      const started = Date.now();
      const timed = await first.exec(["/bin/sleep", "30"], { timeoutMs: 1_000 });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(timed.timedOut || timed.exitCode === 137).toBe(true);

      await first.release({ status: "waiting_approval" });
      const reattached = await sandbox.acquire({ runId });
      expect(reattached.containerId).toBe(containerId);
      expect(text(await reattached.readFile("src/note.txt"))).toBe("note");
      await reattached.release({ status: "waiting_approval" });

      await docker.removeContainer(containerId);
      const restored = await sandbox.acquire({ runId });
      containerId = restored.containerId;
      expect(containerId).not.toBe("");
      expect(text(await restored.readFile("src/note.txt"))).toBe("note");
      await restored.release({ status: "completed" });
      containerId = "";
      await expect(docker.inspectContainer(reattached.containerId)).rejects.toThrow(/not found|no such container/i);
    } finally {
      if (containerId) await docker.removeContainer(containerId).catch(() => undefined);
    }
  }, 180_000);
});
