# @zhivex-ai/sandbox-docker

## 0.2.0

### Minor Changes

- d92ab99: Add a reference Docker execution environment for workspace agents. Each run gets its own non-root container, a declared workspace, filesystem and argv tools, network off by default, resource limits, snapshots, and lease-aware resume.

### Patch Changes

- cb38034: Close sandbox escapes and resource leaks. Workspace reads refuse symlink escapes, snapshot run ids cannot be `.` or `..`, command process groups are killed on return, and the allowlist proxy enforces connection and byte quotas. Sweep deletes only containers with a matching owner and fingerprint. Expired leases drop snapshots, docker-commit images stay referenced until deletion succeeds, and CPU and PID limits are part of the environment fingerprint. OpenAI and Azure apply-patch containment now uses realpath.
- Updated dependencies [e41524d]
- Updated dependencies [1a35b44]
- Updated dependencies [4b20b24]
- Updated dependencies [387e15e]
  - @zhivex-ai/core@1.35.0

## 0.1.0

### Minor Changes

- Add `createDockerSandboxEnvironment` and `createDockerSandboxTools`, a reference Docker execution environment for workspace agents. Each run gets a non-root container, a declared workspace, filesystem and argv tools, network off by default, resource limits, workspace snapshots, and lease-aware resume.
