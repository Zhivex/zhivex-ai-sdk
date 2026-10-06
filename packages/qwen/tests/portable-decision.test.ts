import { createPortableQwenDecisionModel } from "../src/portable-decision.js";
import { it, expect } from 'vitest';
import { decisionFixture, decisionInput } from '../../core/tests/fixtures/decision-contract.js';
it('advertises and rejects unsupported boolean choices, images and refusals', async () => {
  const { model, fetcher } = decisionFixture('qwen');
  expect(model.capabilities).toMatchObject({ perQuestionRefusal: false, choiceValueTypes: ['string'], inputTypes: ['text'], textParts: false });
  await expect(model.decide({ ...decisionInput, input: [{ type: 'image', dataURL: 'data:image/png;base64,AAAA' }] })).rejects.toThrow();
  await expect(model.decide({ input: 'test', questions: { x: { type: 'choice', instructions: 'Pick', choices: [{ value: true, description: 'True' }, { value: false, description: 'False' }] } } })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it('uses the native linear endpoint normalization for portable provenance', () => {
  const base = 'https://decision.example.com/' + '/'.repeat(20_000) + 'v1';
  const model = createPortableQwenDecisionModel('decision-model-preview', { apiKey: 'offline-test', baseURL: base + '///' });
  expect(model.endpoint).toBe(base + '/systemone');
});
