/** Pricing multipliers applied after a model crosses a provider-defined input threshold. */
export interface LongContextPricing {
  inputTokenThreshold: number;
  inputMultiplier: number;
  outputMultiplier: number;
}
