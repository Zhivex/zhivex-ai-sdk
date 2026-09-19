import { GatewayError } from "./types.js";
export class GatewayBudgetError extends GatewayError {
  constructor() { super("Gateway budget reservation denied or unavailable.", false); this.name = "GatewayBudgetError"; }
}
export interface GatewayBudgetReservation {
  /** null retains the entire reservation as uncertain spend; settlement is idempotent. */
  settle(actualAmount: number | null): void | Promise<void>;
  /** Only use when no upstream request was dispatched. */
  cancel(): void | Promise<void>;
}
export interface GatewayBudgetStore {
  reserve(input: { scope: string; currency: string; amount: number; signal?: AbortSignal }): Promise<GatewayBudgetReservation>;
}
export interface GatewayBudgetSnapshot { spent: number; reserved: number; uncertain: number; remaining: number; }
/** Process-local lifetime budgets. Use a new store/scope for a new accounting period. */
export const createGatewayBudgetStore = (options: { limit: number; currency: string; maxScopes?: number }): GatewayBudgetStore & { snapshot(scope: string): GatewayBudgetSnapshot } => {
  const capacity = options.maxScopes ?? 1000;
  if (!Number.isFinite(options.limit) || options.limit < 0 || !options.currency.trim() || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100000) throw new GatewayError("Invalid gateway budget configuration.", false);
  const entries = new Map<string, { spent: number; reserved: number; uncertain: number }>();
  return {
    async reserve({ scope, amount, currency, signal }) {
      signal?.throwIfAborted();
      if (!scope.trim() || scope.length > 256 || currency !== options.currency || !Number.isFinite(amount) || amount <= 0) throw new GatewayBudgetError();
      let entry = entries.get(scope);
      if (!entry) {
        // Never evict spend state: doing so would reset a caller's budget.
        if (entries.size >= capacity) throw new GatewayBudgetError();
        entry = { spent: 0, reserved: 0, uncertain: 0 }; entries.set(scope, entry);
      }
      if (entry.spent + entry.reserved + entry.uncertain + amount > options.limit) throw new GatewayBudgetError();
      entry.reserved += amount;
      let settled = false;
      return {
        settle(actual) {
          if (settled) return;
          if (actual !== null && (!Number.isFinite(actual) || actual < 0)) throw new GatewayBudgetError();
          settled = true; entry!.reserved = Math.max(0, entry!.reserved - amount);
          if (actual === null) entry!.uncertain += amount;
          else entry!.spent += actual;
        },
        cancel() { if (!settled) { settled = true; entry!.reserved = Math.max(0, entry!.reserved - amount); } }
      };
    },
    snapshot(scope) {
      const entry = entries.get(scope) ?? { spent: 0, reserved: 0, uncertain: 0 };
      return { ...entry, remaining: Math.max(0, options.limit - entry.spent - entry.reserved - entry.uncertain) };
    }
  };
};
