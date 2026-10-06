import { experimentalDecisionHelpers, ConfigurationError, ProviderHTTPError, ValidationError, type DecisionInput, type DecisionModel, type DecisionResult } from '@zhivex-ai/core/provider';
const decisionTokenCount: typeof experimentalDecisionHelpers.decisionTokenCount = experimentalDecisionHelpers.decisionTokenCount;
const snapshotDecision: typeof experimentalDecisionHelpers.snapshotDecision = experimentalDecisionHelpers.snapshotDecision;
const validateDecisionAnswers: typeof experimentalDecisionHelpers.validateDecisionAnswers = experimentalDecisionHelpers.validateDecisionAnswers;
const decisionOperation: typeof experimentalDecisionHelpers.decisionOperation = experimentalDecisionHelpers.decisionOperation;

/** Experimental. Registrations authorize only explicitly selected decision destinations. */
export interface GatewayDecisionTarget {
  model: DecisionModel;
  /** Application-supplied conservative reservation including all applicable premiums. Not a provider quote. */
  reserveUSD?: number;
}
export interface GatewayDecisionRequest extends DecisionInput {
  primary: string;
  alternatives?: readonly string[];
  /** Explicit status allowlist. Empty by default; refusals never trigger fallback. */
  fallbackOn?: readonly (429 | 500 | 502 | 503 | 504)[];
  /** Total network attempts, including primary. Defaults to one; no same-target retries. */
  maxAttempts?: number;
  /** Request-local reservation ceiling. Unknown target reservation fails closed. */
  maxReservedUSD?: number;
  allowedProviders?: readonly string[];
  allowedEndpoints?: readonly string[];
  requirePerQuestionRefusal?: boolean;
}
export interface GatewayDecisionResult extends DecisionResult {
  routing: { target: string; attempts: number; reservedUSD?: number };
}
const money = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
// Exact arithmetic over each supplied number's canonical decimal value. Do not
// admit overspending with an epsilon, or round small USD reservations to zero.
type DecimalUSD = { coefficient: bigint; exponent: number };
const decimalUSD = (value: number): DecimalUSD => {
  const [mantissa, exponent = '0'] = value.toString().split('e');
  const [whole, fraction = ''] = mantissa!.split('.');
  return { coefficient: BigInt(whole! + fraction), exponent: Number(exponent) - fraction.length };
};
const alignUSD = (a: DecimalUSD, b: DecimalUSD) => {
  const exponent = Math.min(a.exponent, b.exponent);
  return { a: a.coefficient * 10n ** BigInt(a.exponent - exponent), b: b.coefficient * 10n ** BigInt(b.exponent - exponent), exponent };
};
const addUSD = (a: DecimalUSD, b: DecimalUSD): DecimalUSD => {
  const aligned = alignUSD(a, b);
  return { coefficient: aligned.a + aligned.b, exponent: aligned.exponent };
};
const exceedsUSD = (amount: DecimalUSD, ceiling: DecimalUSD) => {
  const aligned = alignUSD(amount, ceiling);
  return aligned.a > aligned.b;
};
const numberUSD = (amount: DecimalUSD) => {
  const value = Number(`${amount.coefficient}e${amount.exponent}`);
  if (!Number.isFinite(value) || !exceedsUSD(amount, decimalUSD(value))) return value;
  // Public numbers must not under-report a decimal sum between representable
  // values. Admission above still compares the exact sum, not this projection.
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) + 1n);
  return bits.getFloat64(0);
};

export function createGatewayDecide(registry: Readonly<Record<string, GatewayDecisionTarget>> = {}, defaultTimeoutMs?: number) {
  const registrations = Object.fromEntries(Object.entries(registry).map(([id, target]) => [id, { ...target }]));
  return async (request: GatewayDecisionRequest): Promise<GatewayDecisionResult> => {
    if (Object.keys(request).some(k => !['input', 'questions', 'abortSignal', 'timeoutMs', 'primary', 'alternatives', 'fallbackOn', 'maxAttempts', 'maxReservedUSD', 'allowedProviders', 'allowedEndpoints', 'requirePerQuestionRefusal'].includes(k))) throw new ValidationError('Unknown decision option.');
    for (const values of [request.alternatives, request.allowedProviders, request.allowedEndpoints]) {
      if (values !== undefined && (!Array.isArray(values) || !values.every(v => typeof v === 'string' && v.length > 0))) throw new ValidationError('Invalid decision destination restrictions.');
    }
    if (request.requirePerQuestionRefusal !== undefined && typeof request.requirePerQuestionRefusal !== 'boolean' || request.fallbackOn !== undefined && !Array.isArray(request.fallbackOn)) throw new ValidationError('Invalid decision routing controls.');
    const ids = [request.primary, ...(request.alternatives ?? [])];
    const maxAttempts = request.maxAttempts ?? 1;
    const fallbackOn = [...(request.fallbackOn ?? [])];
    const ceiling = request.maxReservedUSD;
    if (!ids.every(id => typeof id === 'string' && id.length > 0) || new Set(ids).size !== ids.length || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > ids.length || fallbackOn.some(status => ![429, 500, 502, 503, 504].includes(status)) || ceiling !== undefined && !money(ceiling)) throw new ValidationError('Invalid decision routing controls.');
    const input = snapshotDecision({ input: request.input, questions: request.questions, abortSignal: request.abortSignal, timeoutMs: request.timeoutMs ?? defaultTimeoutMs });
    // Validate EVERY selected destination before sending evidence to ANY destination.
    const targets = ids.map(id => {
      const t = Object.hasOwn(registrations, id) ? registrations[id] : undefined;
      if (!t) throw new ConfigurationError('Unknown decision destination.');
      const m = t.model;
      if (request.allowedProviders && !request.allowedProviders.includes(m.provider) || request.allowedEndpoints && !request.allowedEndpoints.includes(m.endpoint) || request.requirePerQuestionRefusal && !m.capabilities.perQuestionRefusal) throw new ConfigurationError('Decision destination violates explicit restrictions.');
      if (t.reserveUSD !== undefined && !money(t.reserveUSD) || ceiling !== undefined && t.reserveUSD === undefined) throw new ConfigurationError('A valid decision cost reservation is required for each selected destination.');
      experimentalDecisionHelpers.validateDecision(input, m.capabilities);
      m.validate(input);
      return { id, model: m, reserveUSD: t.reserveUSD };
    });
    if (ceiling !== undefined && targets[0]!.reserveUSD! > ceiling) throw new ValidationError('Decision reservation ceiling exceeded.');
    return decisionOperation(input, async signal => {
      let reserved = decimalUSD(0); let known = true;
      const decimalCeiling = ceiling === undefined ? undefined : decimalUSD(ceiling);
      for (let i = 0; i < maxAttempts; i++) {
        if (signal.aborted) throw new Error('Decision cancelled.');
        const t = targets[i]!;
        if (t.reserveUSD === undefined) known = false;
        const nextReserved = addUSD(reserved, decimalUSD(t.reserveUSD ?? 0));
        if (decimalCeiling !== undefined && exceedsUSD(nextReserved, decimalCeiling)) throw new ValidationError('Decision reservation ceiling exceeded.');
        reserved = nextReserved;
        if (!Number.isFinite(numberUSD(reserved))) throw new ValidationError("Invalid decision reservation sum.");
        try {
          const result = await t.model.decide({ ...input, abortSignal: signal });
          if (result.provenance.provider !== t.model.provider || result.provenance.modelId !== t.model.modelId || result.provenance.endpoint !== t.model.endpoint) throw new ValidationError('Invalid decision provenance.');
          validateDecisionAnswers(result.answers, input.questions, t.model.capabilities.perQuestionRefusal);
          decisionTokenCount(result.usage.inputTokens);
          // Partial refusals are successful typed results, never fallback signals.
          return { ...result, routing: { target: t.id, attempts: i + 1, ...(known ? { reservedUSD: numberUSD(reserved) } : {}) } };
        } catch (error) {
          if (signal.aborted || !(error instanceof ProviderHTTPError) || !fallbackOn.includes(error.status as 429) || i + 1 >= maxAttempts) throw error;
        }
      }
      throw new Error('Decision attempts exhausted.');
    });
  };
}
