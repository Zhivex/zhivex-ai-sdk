# Durable auxiliary compaction

The existing compactor callback and deterministic compaction behavior remain compatible.
When the callback calls a paid model, explicitly configure `compaction.auxiliary` and
attach a run store. Do not run tools in a summarizer. Its callback must forward the
abort signal and idempotency key, respect the reservation, and return normalized
usage. Provider idempotency support is not implied by the SDK key.

```ts
const compaction = {
  maxMessages: 24,
  keepRecentMessages: 8,
  auxiliary: {
    provider: "your-provider",
    modelId: "your-summary-model",
    fingerprint: "summary-prompt-v2-endpoint-a",
    priceRevision: "2026-09",
    pricing: { currency: "USD", inputCostPer1kTokens: 0.001, outputCostPer1kTokens: 0.002 },
    reservation: { inputTokens: 4000, outputTokens: 500, totalTokens: 4500 }
  },
  compactor: summarizeWithoutTools
};
```

`provider` identifies the API host, and `modelId` identifies that route's model.
The route fingerprint must change when endpoint or summary prompt semantics change.
All route settings, including reservation and optional pricing revision, are bound
on resume, including while waiting for approvals. Credentials must never appear in
fingerprints or persisted route metadata. Prices are explicit conservative uncached
rates; `estimatedCost` is an estimate and is not a provider invoice or a monetary
budget limit.

Before dispatch, the runtime checks the reservation against remaining token limits
including known descendant usage and saves an `in-flight` entry in
`state.compactionAttempts`. It saves the provider receipt and counts confirmed usage
before validating a summary. Empty, oversized, non-reducing summaries and subsequent
summary-save failures therefore do not erase billable usage. Each accepted summary
still produces the existing `state.compactions` record; attempts do not imply summary
acceptance. Normal model output ceilings are recalculated after compaction.

Failed calls, cancellation during a call, and responses with missing token counters
become `unknown`. A crash after dispatch leaves `in-flight`. Neither can be retried
automatically on resume. The same attempt ID cannot be dispatched again, including
when a confirmed response contained a rejected summary. Unknown usage is never
reported as confirmed zero. A receipt-save failure retains the in-memory receipt;
if all later persistence attempts fail, the durable in-flight record remains the
safe recovery boundary. External receipt reconciliation is host-owned; this release
does not provide an authenticated reconciliation API for compaction attempts.

The reservation is a conservative caller contract, not an enforcement mechanism
inside arbitrary callback code. Confirmed usage above the reservation is retained
and stops further generation. Store revision checks and worker leases protect one run. For a shared budget,
configure the additive coordinator below. Without a coordinator, paid compaction
with explicitly parallel subagent execution is rejected. The existing tool scheduler
still keeps subagent tools at serial barriers; independent runs can share a coordinator.

In-memory stores support deterministic tests only; use a durable store for process
crash recovery. Registry installation and a Harness consumer validation are separate
release gates from these source and packed-package fixtures.

## Shared token admission (Beta)

```ts
import { createAgentBudgetCoordinator } from "@zhivex-ai/sdk";

const budgetCoordinator = createAgentBudgetCoordinator({
  store,
  budgetId: "tenant-a-task-42",
  scope: { tenantId: "tenant-a" },
  limits: { inputTokens: 10000, outputTokens: 2000, totalTokens: 12000 }
});
const policy = {
  budgetCoordinator,
  modelReservation: { inputTokens: 2000, outputTokens: 300, totalTokens: 2300 }
};
```

Every primary model call reserves `modelReservation`; every auxiliary call reserves
its route allocation. Each child must declare all three finite budget ceilings in
its own `policy.budget`. The parent reserves the entire child allocation before
launch, and the child receives a separate CAS-backed subpool. This avoids double
charging child model receipts to the shared root while admitting competing children
and auxiliary calls atomically. Each child may override `modelReservation` or inherit
its parent's explicit reservation. Unused child allocation is released after a known
result; any child failure retains the allocation conservatively. Primary failures
retain their reservations too. Usage above a reservation is persisted and raises an
error; caller bounds must reflect actual provider request maxima.

Separate coordinator instances with the same budget ID, scope and limits share a
ledger in `AgentRunStore`; the store must honor atomic `expectedRevision` writes.
The built-in file, SQLite and Postgres stores supply their existing CAS semantics.
The coordinator identity is persisted before any provider dispatch and checked on
resume. Duplicate operation IDs never issue another reservation. Unknown receipts
retain their full allocation, and a repeated identical confirmed settlement does
not spend twice. An interrupted primary operation therefore requires external
reconciliation before it can be safely resumed.

Coordinator checkpoints are completed synthetic runs with
`metadata.budgetCoordinator: true`, not runnable agents. They use the reserved `__zhivex_budget__`
namespace, preserving tenant and user and binding the original namespace into the
budget identity, so normal run-scoped retention cannot delete
active allocations. Unscoped budgets use a reserved SDK tenant and namespace. Do not
clean the coordinator namespace while a budget is in use; deleting it resets admission. Ledgers are capped at 4 MiB and do not prune
confirmed IDs, so allocate a new budget identity for a new bounded task rather than
using a lifetime tenant ledger. Counters and prices remain separate: this coordinator
enforces tokens, not monetary costs. Registry/Harness certification remains a
separate post-publication gate.
