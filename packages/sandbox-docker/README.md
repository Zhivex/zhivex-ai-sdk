# @zhivex-ai/sandbox-docker

Experimental reference `executionEnvironment` for Zhivex workspace agents. Each agent run gets its own Docker container. The package stays separate from `@zhivex-ai/core` and `@zhivex-ai/sdk` so the shared contract does not depend on a container engine.

This is a container boundary you run yourself. It is not a hosted sandbox, a microVM, or a local Unix fallback.

## Install

```bash
bun add @zhivex-ai/sandbox-docker @zhivex-ai/sdk
```

The Docker daemon must be reachable at `/var/run/docker.sock`, or pass `socketPath`. The default image is `alpine:3.21`. `packages/sandbox-docker/docker/Dockerfile` is an optional image if you want uid `1000` instead of the default numeric user `65534:65534`.

## Usage

```ts
import { Agent } from "@zhivex-ai/sdk";
import { createDockerSandboxEnvironment, createDockerSandboxTools } from "@zhivex-ai/sandbox-docker";

const sandbox = createDockerSandboxEnvironment({
  workspace: {
    id: "repo",
    files: [{ path: "README.md", contents: "# workspace\n" }],
    directories: ["src"]
  },
  shell: { allow: ["echo", "ls"] }
});

const agent = new Agent({
  model,
  executionEnvironment: sandbox,
  tools: createDockerSandboxTools(),
  maxSteps: 4
});
```

`createDockerSandboxTools()` adds `sandbox_read_file`, `sandbox_write_file`, `sandbox_list`, and `sandbox_exec`. Writes and shell commands require interrupt approval. The tools run only against the session the runtime acquired for that run.

Pass the same environment object, or the same Docker client plus lease and snapshot stores, when the application resumes a run. The runtime releases the session at the end of every invocation. `waiting_approval`, `suspended`, `running`, `queued`, and `cancel_requested` keep the container and refresh the workspace snapshot. `completed`, `failed`, `cancelled`, and `timed_out` remove the container, the snapshot, and any allowlist network.

A changed environment id, workspace id, or manifest fingerprint throws `ConflictError`. An expired lease is removed and is not replaced with an empty workspace. A lost container is restored from the workspace tar when a snapshot exists.

## Security defaults

`dockerSandboxSecurityDefaults` is the reference profile:

| Control | Default |
| --- | --- |
| Image | `alpine:3.21` |
| User | `65534:65534` (numeric, non-root; root is rejected) |
| Workspace | `/workspace` tmpfs, files and directories declared up front |
| Network | `none` |
| Root filesystem | read-only |
| Memory | 256 MiB, swap disabled |
| CPU | 0.5 |
| Process limit | 64 |
| Capabilities | drop `ALL`, `no-new-privileges` |
| Shell | denied until an allowlist or `shell: "allow"` is set |
| Command timeout | 10 seconds |
| Output cap | 1 MiB per stdout and stderr |
| File cap | 1 MiB |
| Workspace cap | 64 MiB |
| Lease | 15 minutes |
| Snapshot | workspace tar |
| Symlinks | not followed; `realpath` must stay inside `/workspace` |
| Undeclared tools | denied |
| Inherited `process.env` | none |
| Local Unix fallback | not implemented |

Host source trees are copied from `workspace.source.include`. They are not bind-mounted. Each file is measured before it is read, and copying stops when the file or workspace budget is exhausted. Shell commands are argv only: a bare name or an executable in `/bin` or `/usr/bin`, with no `..` and no leading `-`. Each command runs under `/usr/bin/timeout -s KILL` in its own session, and the runtime kills that process group when the command returns, times out, is truncated, or is cancelled.

Docker's archive API does not read or write the workspace tmpfs on a read-only root filesystem. Copies in and out of `/workspace` therefore use `/bin/tar` inside the container. The default `alpine:3.21` image provides that binary.

## Network allowlist

`network: { mode: "allowlist", allowedDomains, allowedPorts }` is opt-in. The container joins an internal Docker network and receives `HTTP_PROXY` / `HTTPS_PROXY` aimed at an in-process CONNECT proxy. The proxy allows only the declared public DNS names and ports. It resolves each CONNECT target twice and connects to the checked address. Private, loopback, link-local, metadata, documentation, and non-global addresses are rejected unless `allowPrivateNetworks` is set, including IPv4-mapped, IPv4-compatible, NAT64, and 6to4 forms.

Clients that open sockets directly have no external route. Proxy-aware clients are filtered. The proxy process shares the host network namespace, so a container that can reach the gateway address can also attempt other ports on that gateway. Treat the allowlist as a fail-closed filter for proxy traffic, not as a microVM boundary. Each proxy also enforces connection, in-flight DNS, request, byte, idle, and tunnel-lifetime quotas (`allowlistProxyQuotaDefaults`). Those quotas are part of the manifest fingerprint. The default remains `network: { mode: "deny" }`.

## Snapshots

The workspace lives on a tmpfs, so `docker commit` does not contain it. The default snapshot is a tar of `/workspace`. `snapshot: "docker-commit"` also commits an image and still stores the tar, which is what restore uses. Replacing a snapshot deletes the previous image. Terminal release and lease expiry delete the snapshot and its image.

`sweep()` expires leases this process owns and removes only containers labeled with this environment's owner id and manifest fingerprint. Pass the same `ownerId` when several processes share one lease store and should clean up each other's orphans. A different owner or fingerprint is left alone.

CPU quota, PID limit, and the numeric user are part of the manifest fingerprint. Resume fails when those limits change, and a running container whose Docker HostConfig disagrees with the current limits is rejected. File snapshot keys reject run ids `.` and `..`.

## Assurance

`assurance: "enforced"` is the default for the real Docker client. The in-memory client used by tests and the deterministic example is a double: it refuses `assurance: "enforced"` and records `best-effort` unless you override it. `undeclaredTools: "allow"` permits other in-process tools and does not jail them.
