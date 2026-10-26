# @zhivex-ai/sandbox-docker

## 0.2.2

### Patch Changes

- Raise the declared `@zhivex-ai/core` floor to 1.37.0. This package loads helpers from this Core release, and the declared minimum must match the workspace Core version.
- Updated dependencies [e3f4af2]
  - @zhivex-ai/core@1.37.0

## 0.2.1

### Patch Changes

- Raise the declared `@zhivex-ai/core` floor to 1.36.0. The Docker sandbox loads helpers from this Core release, and the declared minimum must match the workspace Core version.
- Updated dependencies [8e377e4]
- Updated dependencies [7a8b754]
- Updated dependencies [f1ed0ce]
  - @zhivex-ai/core@1.36.0

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
