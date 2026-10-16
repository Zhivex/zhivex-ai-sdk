# @zhivex-ai/sandbox-docker

## 0.1.0

### Minor Changes

- Add `createDockerSandboxEnvironment` and `createDockerSandboxTools`, a reference Docker execution environment for workspace agents. Each run gets a non-root container, a declared workspace, filesystem and argv tools, network off by default, resource limits, workspace snapshots, and lease-aware resume.
