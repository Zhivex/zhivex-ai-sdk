import { calculateModelCost, createCachedGenerateMiddleware, type GenerateResult, type LanguageModel, type ModelGenerateInput, type StreamEvent, type TokenUsage } from "@zhivex-ai/core";
import { type GatewayConfig, type GatewayModelTarget } from "./types.js";
import { GatewayBudgetError, type GatewayBudgetReservation } from "./budget.js";
import type { GatewayAdmissionLease } from "./admission.js";
import { targetKey } from "./target.js";
import { operationControl } from "./operation.js";
export const cachedResults = new WeakSet<GenerateResult>();
const reportedTokens = (usage?: TokenUsage) => usage?.totalTokens !== undefined && Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0 ? usage.totalTokens : undefined;
/** Provider dispatch, resource lifetimes and exact caching are shared by every routed operation. */
export const createGatewayExecutor = (config: GatewayConfig) => {
  const flights = new Map<string, { promise: Promise<GenerateResult>; controller: AbortController; users: number }>();
  let settlementFailures = 0, droppedCacheWrites = 0;
  const cacheWrites = new Set<Promise<void>>();
  const settlements = new Set<Promise<void>>();
  const safe = (action: () => void | Promise<void>) => {
    try {
      const result = action();
      if (result) {
        const control = operationControl(undefined, config.resourceTimeoutMs ?? 1000);
        const completion = control.wait(Promise.resolve(result)).catch(() => { settlementFailures++; }).finally(() => { control.dispose(); settlements.delete(completion); });
        settlements.add(completion);
      }
    } catch { settlementFailures++; }
  };
  const begin = async (target: GatewayModelTarget, input: ModelGenerateInput, scope?: string) => {
    const signal = input.abortSignal;
    signal?.throwIfAborted();
    let admission: GatewayAdmissionLease | undefined, reservation: GatewayBudgetReservation | undefined;
    let started = false, ended = false;
    const finish = async (usage?: TokenUsage) => {
      if (ended) return; ended = true;
      signal?.removeEventListener("abort", abort);
      const acquired = admission; admission = undefined;
      if (acquired) safe(() => acquired.release(reportedTokens(usage)));
      if (reservation) {
        let amount: number | null = null;
        if (usage) {
          try {
            const cost = calculateModelCost({ catalog: config.modelCatalog!, ...target, usage,
              cacheAssumption: config.costAccounting?.cacheAssumption,
              reasoningAccounting: config.costAccounting?.reasoningAccounting?.[target.provider] });
            if (cost.currency === config.budget!.currency && cost.status === "known") amount = cost.amount;
          } catch { /* Unknown usage retains its reservation. */ }
        }
        const held = reservation; reservation = undefined;
        safe(() => started ? held.settle(amount) : held.cancel());
      }
    };
    const abort = () => { void finish(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (config.admission) admission = await config.admission.acquire({ target, signal,
        tokens: input.maxTokens === undefined ? undefined : Math.ceil(JSON.stringify(input.messages).length / 4) + input.maxTokens });
      if (signal?.aborted) {
        const late = admission; admission = undefined;
        if (late) safe(() => late.release());
        signal.throwIfAborted();
      }
      if (config.budget) {
        if (settlementFailures || settlements.size >= 1024 || !scope?.trim()) throw new GatewayBudgetError();
        try { reservation = await config.budget.store.reserve({ scope, currency: config.budget.currency, amount: config.budget.reserveAmount, signal }); }
        catch { throw new GatewayBudgetError(); }
      }
      if (signal?.aborted) {
        const late = reservation; reservation = undefined;
        if (late) safe(() => late.cancel());
        signal.throwIfAborted();
      }
      return { start() { signal?.throwIfAborted(); started = true; }, finish };
    } catch (error) { await finish(); throw error; }
  };
  const generate = async (model: LanguageModel, target: GatewayModelTarget, input: ModelGenerateInput, scope?: string): Promise<GenerateResult> => {
    const lease = await begin(target, input, scope);
    try { lease.start(); const result = await model.generate(input); await lease.finish(result.usage); return result; }
    catch (error) { await lease.finish(); throw error; }
  };
  return {
    diagnostics: () => ({ settlementFailures, pendingSettlements: settlements.size, pendingCacheWrites: cacheWrites.size, droppedCacheWrites, inFlightCacheKeys: flights.size }),
    flush: async () => { await Promise.all([...settlements, ...cacheWrites]); },
    async generate(model: LanguageModel, target: GatewayModelTarget, input: ModelGenerateInput, scope?: string, cacheScope?: string): Promise<GenerateResult> {
      // Cache only pure text model steps; never replay tool calls, provider state or effects.
      const eligible = config.cache && cacheScope?.trim() && !input.tools?.length && !input.providerOptions && input.messages.every(m => m.parts.every(p => p.type === "text"));
      if (!eligible) return generate(model, target, input, scope);
      let key: string | undefined, hit = false;
      const middleware = createCachedGenerateMiddleware({
        scope: JSON.stringify([config.cache!.scope, cacheScope, scope ?? null, targetKey(target)]),
        cache: {
          async get(id) {
            key = id;
            const control = operationControl(input.abortSignal, config.cache!.timeoutMs ?? 50);
            try { const value = await control.wait(Promise.resolve(config.cache!.store.get(id))); if (value) { hit = true; return structuredClone(value); } }
            catch { input.abortSignal?.throwIfAborted(); /* Cache outages are misses. */ }
            finally { control.dispose(); }
            return undefined;
          },
          set(id, value) {
            // Stores may hang: writes must never delay a completed provider response.
            if (value.finishReason === "tool-calls" || value.audio?.length || value.images?.length ||
                value.message?.parts.some(part => part.type !== "text") ||
                value.messages?.some(message => message.parts.some(part => part.type !== "text"))) return;
            if (cacheWrites.size >= 256) { droppedCacheWrites++; return; }
            const control = operationControl(undefined, config.cache!.timeoutMs ?? 50);
            try {
              const write = control.wait(Promise.resolve(config.cache!.store.set(id, structuredClone(value))))
                .catch(() => undefined).finally(() => { control.dispose(); cacheWrites.delete(write); });
              cacheWrites.add(write);
            } catch { control.dispose(); }

          }
        }
      });
      const result = await middleware.wrapGenerate!({ model, input }, async () => {
        input.abortSignal?.throwIfAborted();
        if (!key) return generate(model, target, input, scope);
        let flight = flights.get(key);
        if (!flight) {
          if (flights.size >= 1024) return generate(model, target, input, scope);
          const controller = new AbortController();
          const promise = generate(model, target, { ...input, abortSignal: controller.signal }, scope);
          flight = { controller, promise, users: 0 }; flights.set(key, flight);
          const id = key, current = flight;
          void promise.finally(() => { if (flights.get(id) === current) flights.delete(id); }).catch(() => undefined);
        } else hit = true;
        flight.users++;
        const wait = operationControl(input.abortSignal);
        try { return structuredClone(await wait.wait(flight.promise)); }
        finally {
          wait.dispose(); flight.users--;
          if (flight.users === 0) { if (flights.get(key) === flight) flights.delete(key); flight.controller.abort(); }
        }
      });
      input.abortSignal?.throwIfAborted();
      if (hit) cachedResults.add(result);
      return result;
    },
    async stream(model: LanguageModel, target: GatewayModelTarget, input: ModelGenerateInput, scope?: string): Promise<AsyncIterable<StreamEvent>> {
      const lease = await begin(target, input, scope);
      try {
        lease.start();
        const source = await model.stream!(input);
        return (async function* () {
          let usage: TokenUsage | undefined;
          try {
            for await (const event of source) { if (event.type === "finish") usage = event.usage; yield event; }
          } finally { await lease.finish(usage); }
        })();
      } catch (error) { await lease.finish(); throw error; }
    }
  };
};
