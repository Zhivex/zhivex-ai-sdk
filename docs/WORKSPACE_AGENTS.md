# Workspace Agents Guide

Workspace agents are agents that can inspect or modify a filesystem, run commands, or apply patches. They are powerful and risky. Treat them as a production safety boundary, not just a tool-calling convenience.

Zhivex AI SDK supports workspace-style agents through the same portable agent runtime plus provider-specific harness tools where available. It does not currently ship a managed sandbox service, browser workspace, hosted VNC session, or operator UI.

## Current Capability

The SDK can support workspace-oriented flows through:

- `Agent` / `runAgent()` / `streamAgent()` for resumable execution.
- tool approval policies and production safety policies.
- OpenAI and Azure OpenAI Responses harness tools such as `shell` and `apply_patch`.
- app-owned local tools for repository search, file reads, diffs, tests, or CI checks.
- run stores, audit records, ledgers, traces, and golden traces.
- provider support helpers to route only to models that advertise needed agent capabilities.

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

Keep `applyOperation` app-owned. Many products should record proposed patches for review instead of applying them automatically.

## Safety Requirements

For workspace agents, enforce:

- `rootDir`: keep file reads/writes inside the intended workspace.
- `timeoutMs`: bound shell execution time.
- `maxOutputLength`: bound shell output.
- approval policy: require human approval for shell, patch, filesystem, network, code-execution, deployment, publish, transfer, or payment actions.
- durable state: persist the run before and after tool calls.
- audit export: record redacted run and tool audit records.
- no implicit secrets: do not expose environment variables unless the tool explicitly needs them.

## Approval Pattern

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

OpenAI Agents SDK and some product frameworks emphasize managed sandbox execution, workspace snapshots, voice/realtime surfaces, or operator UIs. Zhivex currently positions workspace agents as a portable SDK runtime plus app-owned execution boundary.

That means Zhivex is a good fit when:

- the application already owns its workspace, auth, tenancy, and approval UI
- provider portability matters
- audit records and explicit state are required
- the product wants to route between OpenAI, Azure OpenAI, and other providers by capability

Do not present Zhivex as a hosted sandbox platform unless the release also includes managed isolated execution, workspace snapshots, and a user-facing operator UI.

## Release Checklist

Before marketing workspace-agent support:

1. Verify provider capability routing rejects models without required harness features.
2. Verify shell and patch tools require approval by default.
3. Verify `rootDir` prevents path escape.
4. Verify command output is bounded.
5. Verify rejected approvals do not execute the tool.
6. Export a ledger and tool audit records from a deterministic run.
7. Document any provider-specific setup needed for remote MCP, shell, apply patch, or computer-use tools.
