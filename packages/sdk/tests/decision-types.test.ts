import { it, expectTypeOf } from 'vitest';
import type { DecisionModel, DecisionInput, DecisionAnswer } from '../src/index.js';
it('re-exports the experimental portable decision types', () => {
  expectTypeOf<DecisionModel['decide']>().parameter(0).toEqualTypeOf<DecisionInput>();
  expectTypeOf<Extract<DecisionAnswer, { type: 'refusal' }>>().toEqualTypeOf<{ type: 'refusal' }>();
});
