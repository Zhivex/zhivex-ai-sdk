import { randomUUID } from "node:crypto";

import type {
  DockerClient,
  DockerCreateSpec,
  DockerExecOptions,
  DockerExecResult,
  DockerPathStat
} from "./docker-client.js";
import { SandboxError } from "./errors.js";
import { packTar, unpackTar, type TarEntry } from "./tar.js";

interface MemoryNode {
  type: "file" | "directory" | "symlink";
  content: Uint8Array;
  mode: number;
  linkTarget: string;
}

interface MemoryContainer {
  id: string;
  spec: DockerCreateSpec;
  running: boolean;
  oomKilled: boolean;
  exitCode: number;
  files: Map<string, MemoryNode>;
}

interface MemoryImage {
  files: Map<string, MemoryNode>;
}

const empty = new Uint8Array();
const text = (value: string) => new TextEncoder().encode(value);

const cloneFiles = (files: Map<string, MemoryNode>) => {
  const copy = new Map<string, MemoryNode>();
  for (const [key, node] of files) {
    copy.set(key, { ...node, content: new Uint8Array(node.content) });
  }
  return copy;
};

const basename = (value: string) => value.slice(value.lastIndexOf("/") + 1);

export interface MemoryDockerClient extends DockerClient {
  specs(): DockerCreateSpec[];
  containerIds(): string[];
  createdContainerIds(): string[];
  removedNetworkIds(): string[];
  imageCount(): number;
}

export const createMemoryDockerClient = (): MemoryDockerClient => {
  const containers = new Map<string, MemoryContainer>();
  const images = new Map<string, MemoryImage>();
  const maxImages = 32;
  const networks = new Map<string, { id: string; gateway: string }>();
  const removedNetworks: string[] = [];
  const createdIds: string[] = [];

  const requireContainer = (id: string) => {
    const container = containers.get(id);
    if (!container || !container.running) throw new SandboxError("NOT_FOUND", `Sandbox container ${id} is not running.`);
    return container;
  };

  const seed = (files: Map<string, MemoryNode>) => {
    for (const directory of ["/", "/tmp", "/workspace"]) {
      files.set(directory, { type: "directory", content: empty, mode: 0o755, linkTarget: "" });
    }
  };

  const place = (files: Map<string, MemoryNode>, destination: string, entries: readonly TarEntry[]) => {
    const base = destination.endsWith("/") ? destination.slice(0, -1) : destination;
    for (const entry of entries) {
      const target = entry.path ? `${base}/${entry.path}`.replace(/\/+/g, "/") : base;
      files.set(target, {
        type: entry.type,
        content: entry.content ? new Uint8Array(entry.content) : empty,
        mode: entry.mode ?? 0o644,
        linkTarget: entry.linkTarget ?? ""
      });
    }
  };

  const archiveOf = (files: Map<string, MemoryNode>, containerPath: string): { tar: Uint8Array; stat: DockerPathStat } => {
    const node = files.get(containerPath);
    if (!node) throw new SandboxError("NOT_FOUND", `Sandbox path ${containerPath} was not found.`);
    if (node.type === "file" || node.type === "symlink") {
      return {
        tar: packTar([{
          path: basename(containerPath),
          type: node.type,
          content: node.content,
          linkTarget: node.linkTarget,
          mode: node.mode
        }]),
        stat: { name: basename(containerPath), size: node.content.byteLength, mode: node.mode, linkTarget: node.linkTarget }
      };
    }
    const rootName = basename(containerPath);
    const entries: TarEntry[] = [{ path: rootName, type: "directory", mode: node.mode }];
    const prefix = containerPath.endsWith("/") ? containerPath : `${containerPath}/`;
    for (const [key, child] of files) {
      if (!key.startsWith(prefix) || key === containerPath) continue;
      entries.push({
        path: `${rootName}/${key.slice(prefix.length)}`,
        type: child.type,
        content: child.content,
        linkTarget: child.linkTarget,
        mode: child.mode
      });
    }
    return {
      tar: packTar(entries),
      stat: { name: rootName, size: 0, mode: node.mode, linkTarget: "" }
    };
  };

  const runExec = (container: MemoryContainer, options: DockerExecOptions): DockerExecResult => {
    let argv = options.cmd;
    let timeoutSeconds: number | undefined;
    if ((argv[0] === "/bin/timeout" || argv[0] === "/usr/bin/timeout") && argv[1] === "-s" && argv[2] === "KILL") {
      timeoutSeconds = Number(argv[3]);
      argv = argv.slice(4);
    }
    const command = argv[0] === "/bin/echo" || argv[0] === "echo"
      ? { exitCode: 0, stdout: text(`${argv.slice(1).join(" ")}\n`), stderr: empty }
      : argv[0] === "/bin/id"
        ? { exitCode: 0, stdout: text(`${container.spec.user.split(":")[0]}\n`), stderr: empty }
        : argv[0] === "/bin/cat"
          ? readFile(container, argv[1] ?? "")
          : argv[0] === "/bin/ls"
            ? listDirectory(container, argv.at(-1) ?? container.spec.workingDir)
            : argv[0] === "/bin/sleep" || argv[0] === "sleep"
              ? sleepResult(Number(argv[1]), timeoutSeconds)
              : argv[0] === "/bin/kill"
                ? { exitCode: 0, stdout: empty, stderr: empty }
                : { exitCode: 127, stdout: empty, stderr: text(`command not found: ${argv[0] ?? ""}\n`) };
    const stdout = command.stdout.length > options.maxOutputBytes ? command.stdout.subarray(0, options.maxOutputBytes) : command.stdout;
    const stderr = command.stderr.length > options.maxOutputBytes ? command.stderr.subarray(0, options.maxOutputBytes) : command.stderr;
    return {
      exitCode: command.exitCode,
      stdout,
      stderr,
      truncated: command.stdout.length > options.maxOutputBytes || command.stderr.length > options.maxOutputBytes,
      timedOut: "timedOut" in command ? Boolean(command.timedOut) : false
    };
  };

  return {
    kind: "memory",
    specs: () => [...containers.values()].map(container => structuredClone(container.spec)),
    containerIds: () => [...containers.keys()],
    createdContainerIds: () => [...createdIds],
    removedNetworkIds: () => [...removedNetworks],
    imageCount: () => images.size,
    async createContainer(spec) {
      const id = `mem_${randomUUID()}`;
      const image = images.get(spec.image);
      const files = image ? cloneFiles(image.files) : new Map<string, MemoryNode>();
      if (!image) seed(files);
      containers.set(id, { id, spec: structuredClone(spec), running: false, oomKilled: false, exitCode: 0, files });
      createdIds.push(id);
      return { Id: id };
    },
    async startContainer(id) {
      const container = containers.get(id);
      if (!container) throw new SandboxError("NOT_FOUND", `Sandbox container ${id} was not found.`);
      container.running = true;
    },
    async inspectContainer(id) {
      const container = containers.get(id);
      if (!container) throw new SandboxError("NOT_FOUND", `Sandbox container ${id} was not found.`);
      return {
        Id: id,
        State: {
          Running: container.running,
          Status: container.running ? "running" : "exited",
          OOMKilled: container.oomKilled,
          ExitCode: container.exitCode
        }
      };
    },
    async removeContainer(id) {
      containers.delete(id);
    },
    async killContainer(id) {
      const container = containers.get(id);
      if (!container) throw new SandboxError("NOT_FOUND", `Sandbox container ${id} was not found.`);
      container.running = false;
      container.exitCode = 137;
    },
    async listContainers(label) {
      const separator = label.indexOf("=");
      const key = separator === -1 ? label : label.slice(0, separator);
      const value = separator === -1 ? "" : label.slice(separator + 1);
      return [...containers.values()]
        .filter(container => container.spec.labels[key] === value)
        .map(container => ({ Id: container.id, Labels: { ...container.spec.labels } }));
    },
    async putArchive(id, containerPath, tar) {
      place(requireContainer(id).files, containerPath, unpackTar(tar));
    },
    async getArchive(id, containerPath) {
      return archiveOf(requireContainer(id).files, containerPath);
    },
    async exec(id, options) {
      return runExec(requireContainer(id), options);
    },
    async commitContainer(id, _repo, tag) {
      const container = requireContainer(id);
      const imageId = `sha256:${tag}`;
      images.set(imageId, { files: cloneFiles(container.files) });
      while (images.size > maxImages) {
        const oldest = images.keys().next().value;
        if (oldest === undefined) break;
        images.delete(oldest);
      }
      return { Id: imageId };
    },
    async createNetwork(name) {
      const id = `net_${name}`;
      networks.set(id, { id, gateway: "10.88.0.1" });
      return { Id: id, gateway: "10.88.0.1" };
    },
    async removeNetwork(id) {
      networks.delete(id);
      removedNetworks.push(id);
    }
  };
};

const readFile = (container: MemoryContainer, containerPath: string) => {
  const node = container.files.get(containerPath);
  if (!node || node.type !== "file") {
    return { exitCode: 1, stdout: empty, stderr: text(`cat: ${containerPath}: No such file\n`) };
  }
  return { exitCode: 0, stdout: node.content, stderr: empty };
};

const listDirectory = (container: MemoryContainer, containerPath: string) => {
  const directory = container.files.get(containerPath);
  if (!directory || directory.type !== "directory") {
    return { exitCode: 1, stdout: empty, stderr: text(`ls: ${containerPath}: No such file or directory\n`) };
  }
  const prefix = containerPath.endsWith("/") ? containerPath : `${containerPath}/`;
  const names = new Set<string>();
  for (const key of container.files.keys()) {
    if (!key.startsWith(prefix) || key === containerPath) continue;
    const name = key.slice(prefix.length).split("/")[0];
    if (name) names.add(name);
  }
  const listing = [...names].sort();
  return { exitCode: 0, stdout: text(listing.length ? `${listing.join("\n")}\n` : ""), stderr: empty };
};

const sleepResult = (requested: number, timeoutSeconds: number | undefined) => {
  if (timeoutSeconds !== undefined && requested >= timeoutSeconds) {
    return { exitCode: 137, stdout: empty, stderr: empty, timedOut: true };
  }
  return { exitCode: 0, stdout: empty, stderr: empty, timedOut: false };
};
