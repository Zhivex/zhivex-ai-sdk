import { AGENT_RUN_STATE_SCHEMA_VERSION } from "./agent-state.js";
import { ConflictError, ValidationError } from "./errors.js";
import { fingerprintAgentHarness } from "./agent-harness.js";
import type { AgentRunState, AgentRunStore, AgentStoreScope, TokenUsage, JsonValue } from "./types.js";

export interface AgentTokenReservation { inputTokens: number; outputTokens: number; totalTokens: number }
export interface AgentBudgetCoordinator {
  /** Stable non-secret identity, bound to run resumes. */
  id: string;
  /** Independent ceilings; total may constrain input and output below their combined ceilings. */
  reserve(id: string, tokens: AgentTokenReservation): Promise<void>;
  /** Missing usage retains the full allocation and blocks reuse of this operation. */
  settle(id: string, usage?: TokenUsage): Promise<void>;
}
export interface AgentBudgetCoordinatorOptions {
  store: AgentRunStore;
  budgetId: string;
  scope?: AgentStoreScope;
  limits: AgentTokenReservation;
}
type Allocation = { status: "reserved" | "confirmed" | "unknown"; tokens: AgentTokenReservation };
const assertTokenCeilings = (tokens: AgentTokenReservation): void => {
  if (![tokens.inputTokens, tokens.outputTokens, tokens.totalTokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new ValidationError("A token reservation requires finite nonnegative input, output and total ceilings.");
  }
};
export const assertAgentTokenReservation = (tokens: AgentTokenReservation): void => {
  if (![tokens.inputTokens, tokens.outputTokens, tokens.totalTokens].every(value => Number.isSafeInteger(value) && value >= 0) || tokens.totalTokens < tokens.inputTokens + tokens.outputTokens) {
    throw new ValidationError("A token reservation requires finite nonnegative input, output and total ceilings.");
  }
};

/** Atomic shared token admission using the run store's compare-and-swap contract. */
export const createAgentBudgetCoordinator = (options: AgentBudgetCoordinatorOptions): AgentBudgetCoordinator => {
  if (![options.limits.inputTokens, options.limits.outputTokens, options.limits.totalTokens].every(value => Number.isSafeInteger(value) && value >= 0)) throw new ValidationError("Shared budget limits must be finite nonnegative integers.");
  if (!options.budgetId) throw new ValidationError("budgetId is required.");
  const limits = structuredClone(options.limits);
  const sourceScope = options.scope ? structuredClone(options.scope) : undefined;
  if (sourceScope?.namespace === "__zhivex_budget__") throw new ValidationError("The budget ledger namespace is reserved.");
  const scope: AgentStoreScope = {
    tenantId: sourceScope?.tenantId ?? "__zhivex_unscoped_budget__",
    ...(sourceScope?.userId ? { userId: sourceScope.userId } : {}),
    // The source namespace is bound into the identity below, not the filename.
    // This also keeps atomic file-store names bounded for UUID tenant/user IDs.
    namespace: "__zhivex_budget__"
  };
  const identity = fingerprintAgentHarness({ budgetId: options.budgetId, scope: sourceScope ?? null, limits });
  const runId = `budget_${fingerprintAgentHarness({ budgetId: options.budgetId, scope: sourceScope ?? null }).slice("sha256:".length)}`;
  const update = async (mutate: (allocations: Record<string, Allocation>) => void) => {
    for (let retry = 0; retry < 32; retry++) {
      const current = await options.store.load(runId, scope);
      if (current && current.metadata?.budgetIdentity !== identity) throw new ConflictError("Shared budget configuration changed.");
      const allocations = structuredClone((current?.metadata?.allocations ?? {}) as unknown as Record<string, Allocation>);
      if (!allocations || typeof allocations !== "object" || Array.isArray(allocations)) throw new ValidationError("Invalid shared budget ledger.");
      for (const entry of Object.values(allocations)) {
        if (!entry || !["reserved", "confirmed", "unknown"].includes(entry.status) || !entry.tokens) throw new ValidationError("Invalid shared budget allocation.");
        // Reservations are independent upper bounds; confirmed receipts are usage.
        // A resumed child's remaining total can be below its component sum.
        if (entry.status === "confirmed") assertAgentTokenReservation(entry.tokens);
        else assertTokenCeilings(entry.tokens);
      }
      mutate(allocations);
      const revision = current?.revision ?? 0;
      const next: AgentRunState = {
        schemaVersion: AGENT_RUN_STATE_SCHEMA_VERSION, runId, scope: scope, revision: revision + 1,
        provider: "zhivex", modelId: "budget-coordinator", status: "completed",
        messages: [], steps: [], toolResults: [], pendingApprovals: [], currentStep: 0,
        maxSteps: 1, outputText: "", updatedAt: Date.now(),
        metadata: { budgetIdentity: identity, budgetCoordinator: true, allocations: allocations as unknown as JsonValue }
      };
      if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 4 * 1024 * 1024) throw new ValidationError("Shared budget ledger exceeds 4 MiB; rotate the budget identity before admitting more operations.");
      try { await options.store.save(next, { expectedRevision: revision }); return; }
      catch (error) { if (!(error instanceof ConflictError) || retry === 31) throw error; }
    }
  };
  return {
    id: identity,
    reserve: async (id, tokens) => {
      assertTokenCeilings(tokens);
      tokens = { ...tokens };
      const key = fingerprintAgentHarness(id);
      await update(allocations => {
        if (allocations[key]) throw new ValidationError("Shared budget operation was already reserved; automatic retry is unsafe.");
        for (const dimension of ["inputTokens", "outputTokens", "totalTokens"] as const) {
          const used = Object.values(allocations).reduce((sum, entry) => sum + entry.tokens[dimension], 0);
          if (used + tokens[dimension] > limits[dimension]) throw new ValidationError(`Shared budget reservation exceeds ${dimension}.`);
        }
        allocations[key] = { status: "reserved", tokens: { ...tokens } };
      });
    },
    settle: async (id, usage) => {
      const key = fingerprintAgentHarness(id);
      const complete = usage && [usage.inputTokens, usage.outputTokens, usage.totalTokens].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
      let exceeded = false;
      await update(allocations => {
        const entry = allocations[key];
        if (!entry) throw new ValidationError("Cannot settle an unreserved budget operation.");
        if (!complete) { if (entry.status !== "confirmed") entry.status = "unknown"; return; }
        const tokens = { inputTokens: usage!.inputTokens!, outputTokens: usage!.outputTokens!, totalTokens: usage!.totalTokens! };
        assertAgentTokenReservation(tokens);
        if (entry.status === "confirmed" && fingerprintAgentHarness(entry.tokens) !== fingerprintAgentHarness(tokens)) throw new ConflictError("Conflicting budget receipt.");
        exceeded = ["inputTokens", "outputTokens", "totalTokens"].some(key => {
          const dimension = key as keyof AgentTokenReservation;
          return tokens[dimension] > entry.tokens[dimension];
        });
        allocations[key] = { status: "confirmed", tokens };
      });
      if (!complete) throw new ValidationError("Shared budget usage is unknown; reservation retained.");
      if (exceeded) throw new ValidationError("Confirmed usage exceeded shared budget reservation.");
    }
  };
};
