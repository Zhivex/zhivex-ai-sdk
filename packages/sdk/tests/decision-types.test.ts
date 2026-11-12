import { it, expectTypeOf } from 'vitest';
import type { DecisionModel, DecisionInput, DecisionAnswer } from '../src/index.js';
it('re-exports the experimental portable decision types', () => {
  expectTypeOf<DecisionModel['decide']>().parameter(0).toEqualTypeOf<DecisionInput>();
  expectTypeOf<Extract<DecisionAnswer, { type: 'refusal' }>>().toEqualTypeOf<{ type: 'refusal' }>();
});

it('exposes multimodal decisions and predicate confidence through the SDK', () => {
  const input = {
    input: [
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      { type: 'video', uri: 'https://example.com/clip.mp4', mimeType: 'video/mp4', resolution: 'medium' },
      { type: 'document', data: 'AAAA', mimeType: 'application/pdf' },
      { type: 'image', data: 'AAAA', mimeType: 'image/heic', resolution: 'ultra_high' }
    ],
    questions: { check: { type: 'predicate', instructions: 'Does the evidence match?', trueDescription: 'Matches', falseDescription: 'Does not match' } }
  } satisfies DecisionInput;
  expectTypeOf(input).toExtend<DecisionInput>();
  expectTypeOf<Extract<DecisionAnswer, { type: 'predicate' }>['providerConfidence']>().toEqualTypeOf<number | undefined>();
});
