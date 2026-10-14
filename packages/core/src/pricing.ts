/** Pricing multipliers applied after a model crosses a provider-defined input threshold. */
export interface LongContextPricing {
  inputTokenThreshold: number;
  /**
   * When true, the threshold itself uses long-context rates (`>=`).
   * Omitted or false keeps the original exclusive comparison (`>`).
   */
  inputTokenThresholdInclusive?: boolean;
  inputMultiplier: number;
  outputMultiplier: number;
}

/** Whether input token usage falls in the long-context price tier. */
export const appliesLongContextPricing = (inputTokens: number, pricing: LongContextPricing): boolean =>
  pricing.inputTokenThresholdInclusive === true
    ? inputTokens >= pricing.inputTokenThreshold
    : inputTokens > pricing.inputTokenThreshold;
