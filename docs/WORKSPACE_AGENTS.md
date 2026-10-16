# Workspace Agents Guide

Workspace agents are agents that can inspect or modify a filesystem, run commands, or apply patches. They are powerful and risky. Treat them as a production safety boundary, not just a tool-calling convenience.

Zhivex AI SDK supports workspace-style agents through the same portable agent runtime plus provider-specific harness tools where available. `@zhivex-ai/sandbox-docker` is an experimental reference Docker `executionEnvironment`. The SDK still does not ship a hosted sandbox, a browser workspace, a hosted VNC session, or an operator UI.

## Current Capability

The SDK can support workspace-oriented flows through:

- `Agent` / `runAgent()` / `streamAgent()` for resumable execution.
- tool approval policies and production safety policies.
- OpenAI and Azure OpenAI Responses harness tools such as `shell` and `apply_patch`.
- app-owned local tools for repository search, file reads, diffs, tests, or CI checks.
- run stores, audit records, ledgers, traces, and golden traces.
- provider support helpers to route only to models that advertise needed agent capabilities.

## First-Class Execution Environment

`AgentDefinition.executionEnvironment` is the provider-neutral contract for app-owned execution. Its serializable manifest declares the backend, assurance level, isolation mode, workspace policy, permissions, and limits. A canonical fingerprint is stored in `AgentRunState`; resume fails before execution if the manifest or workspace identity changes.

For each active run, the adapter:

1. acquires an ephemeral session,
2. authorizes the complete model-produced tool batch before any call executes,
3. reauthorizes each call immediately before the side effect,
4. executes through the acquired session, and
5. releases the session with the final run status.

Tool callbacks, credentials, clients, and acquired handles are not serialized. They must be supplied again by the application on resume. An adapter declaring `assurance: "enforced"` is responsible for making the declared filesystem, network, process, resource, and tenancy controls real. The SDK wrapper supplies durable binding and authorization sequencing; it does not turn an in-process callback into a container or microVM.

Use `createAgentExecutionEnvironmentBinding()` from `@zhivex-ai/sdk` or `@zhivex-ai/agents/beta` when constructing the acquired session. The runtime independently recomputes the manifest fingerprint and rejects a session that differs from the durable run.

## Reference Docker Sandbox

`@zhivex-ai/sandbox-docker` implements that contract with one container per run. It is a separate package so Docker stays out of `core` and the aggregated SDK. Install it only when the application will run a local or self-hosted Docker daemon:

```bash
bun add @zhivex-ai/sandbox-docker @zhivex-ai/sdk
```

```ts
import { Agent } from "@zhivex-ai/sdk";
import { createDockerSandboxEnvironment, createDockerSandboxTools } from "@zhivex-ai/sandbox-docker";

const sandbox = createDockerSandboxEnvironment({
  workspace: {
    id: "repo",
    files: [{ path: "README.md", contents: "# workspace\n" }]
  },
  shell: { allow: ["echo"] }
});

const agent = new Agent({
  model,
  executionEnvironment: sandbox,
  tools: createDockerSandboxTools()
});
```

The default profile uses `alpine:3.21`, user `65534:65534`, a read-only root filesystem, network mode `none`, dropped capabilities, memory and CPU limits, and a tmpfs at `/workspace`. Declared files and directories are copied in. The host tree is not bind-mounted. Shell commands are argv-only, denied until you pass an allowlist, and capped by timeout and output size. Writes and `sandbox_exec` require interrupt approval.

There is no local Unix fallback. A host process cannot honestly claim network-off, a non-root user, cgroup limits, and filesystem confinement at the same time without a kernel sandbox, and that sandbox is easy to get wrong. Use Docker or keep execution app-owned.

`network.mode: "allowlist"` is opt-in. It attaches an internal Docker network and an in-process HTTP CONNECT proxy. Direct sockets still have no external route. The proxy can reach other ports on the Docker gateway, so this is not a microVM. Leave the default `deny` in place unless the workload needs filtered proxy egress.

Snapshots store a tar of `/workspace` because that directory is a tmpfs and `docker commit` would miss it. `snapshot: "docker-commit"` also records an image id. Pause statuses keep the container and refresh the snapshot. Terminal statuses remove the container, the snapshot, and any allowlist network. Resume with the same environment object, or the same Docker client and lease/snapshot stores. A changed fingerprint fails before execution. An expired lease is not replaced with an empty workspace.

`examples/sandbox-docker/workspace-agent.ts` walks the approval pause and reattach path with the in-memory Docker double. It does not need a daemon. Set `ZHIVEX_SANDBOX_DOCKER=1` to run the real-container integration test where Docker is installed.

## Provider Harness Tools

OpenAI and Azure OpenAI expose SDK-managed local harness tools for Responses shell and patch calls. These tools require approval by default.

```ts
import { Agent, createAgentToolPolicy } from "@zhivex-ai/sdk";
import { createOpenAI, openAIApplyPatchTool, openAIShellTool } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const agent = new Agent({
  model: openai("gpt-5"),
  instructions: "Inspect the repository and propose minimal changes.",
  maxSteps: 8,
  tools: {
    shell: openAIShellTool({
      rootDir: process.cwd(),
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxOutputLength: 20_000
    }),
    apply_patch: openAIApplyPatchTool({
      rootDir: process.cwd(),
      applyOperation: async (operation) => {
        return {
          status: "review-required",
          operation
        };
      }
    })
  },
  toolApprovalPolicy: createAgentToolPolicy({
    mode: "supervised",
    denyRiskLevels: ["critical"]
  })
});
```

`supervised` requests resumable approval for tools marked `requiresApproval`, high-risk tools, and tools declaring network or write-like permissions. Use `allowToolNames` or `allowPermissions` only for explicit reviewed exceptions; critical risk remains denied by default.

Keep `applyOperation` app-owned. Many products should record proposed patches for review instead of applying them automatically.

## Safety Requirements

For workspace agents, enforce:

- `rootDir`: keep file reads/writes inside the intended workspace.
- `timeoutMs`: bound shell execution time.
- `maxOutputLength`: bound shell output.
- approval policy: require human approval for shell, patch, filesystem, network, code-execution, deployment, publish, transfer, or payment actions.
- durable state: persist the run before and after tool calls.
- durable subagents: use a run store with atomic idempotency claims so a completed child is reused after a failed parent checkpoint.
- durable identity: resume with the same capsule fingerprint and execution-environment binding.
- audit export: record redacted run and tool audit records.
- no implicit secrets: do not expose environment variables unless the tool explicitly needs them.

## Approval Pattern

Local workspace tools should set `requiresApproval: true` and `approvalMode: "interrupt"`, or use a policy that returns `{ approved: false, approvalRequired: true }`. The runtime preflights the full tool-call batch and records local decisions in agent state without exposing them to the provider.

```ts
const first = await agent.run({
  prompt: "Run tests and propose the smallest patch."
});

if (first.status === "waiting_approval") {
  // Surface first.state.pendingApprovals to your product UI or queue.
  const resumed = await agent.resume({
    state: first.state,
    approvals: first.state.pendingApprovals.map((request) => ({
      provider: request.provider,
      approvalRequestId: request.id,
      approve: true
    }))
  });
}
```

Use `createAgentApprovalQueue()` when approvals need durable queue items with tokens and resume URLs.

Use `approvalVersion` and, for durable multi-worker systems, `toolApprovalSigner` so an approval cannot be replayed after the tool contract or bound input changes. Re-supply validated application `context` on resume; it is intentionally not persisted in the run state.

## App-Owned Local Tools

For most products, prefer narrow local tools over a generic shell:

- `searchFiles({ query })`
- `readFile({ path })`
- `listChangedFiles()`
- `runTest({ script })` with a fixed allowlist
- `proposePatch({ path, diff })`
- `createPullRequestDraft({ title, body, patchId })`

Narrow tools are easier to approve, audit, test, and explain than arbitrary command execution.

## Observability

Workspace agents should create ledgers:

```ts
import { createAgentRunLedger } from "@zhivex-ai/sdk";

const ledger = createAgentRunLedger(result.state, {
  includeTimeline: true,
  includeInput: false,
  includeOutput: false,
  includeMetadata: true
});
```

Store ledgers with the proposed patch, test output, approval records, and final commit or PR reference.

## Competitive Boundary

OpenAI Agents SDK and some product frameworks emphasize hosted sandbox execution, workspace snapshots, voice/realtime surfaces, or operator UIs. Zhivex positions workspace agents as a portable SDK runtime plus a first-class, app-owned execution-environment contract. `@zhivex-ai/sandbox-docker` is a reference container adapter for that contract. It does not make Zhivex a hosted sandbox platform.

That means Zhivex is a good fit when:

- the application already owns its workspace, auth, tenancy, and approval UI
- provider portability matters
- audit records and explicit state are required
- the product wants to route between OpenAI, Azure OpenAI, and other providers by capability

Do not present Zhivex as a hosted sandbox platform. The Docker package is a self-hosted reference boundary. A hosted product would still need managed isolated execution, workspace snapshots operated as a service, and a user-facing operator UI.

## Release Checklist

Before marketing workspace-agent support:

1. Verify provider capability routing rejects models without required harness features.
2. Verify shell and patch tools require approval by default.
3. Verify `rootDir` prevents path escape.
4. Verify command output is bounded.
5. Verify rejected approvals do not execute the tool.
6. Verify execution-environment batch denial is atomic and execute-time authorization is enforced.
7. Verify a changed harness or environment fingerprint cannot resume the run.
8. Export a ledger and tool audit records from a deterministic run.
9. Document any provider-specific setup needed for remote MCP, shell, apply patch, or computer-use tools.
