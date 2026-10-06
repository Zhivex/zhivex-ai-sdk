import { it, expect } from 'vitest';
import { decisionFixture, decisionInput } from '../../core/tests/fixtures/decision-contract.js';
it('returns partial refusals without converting them to numeric answers', async () => {
  const { model, payload } = decisionFixture('openai');
  payload.answers[0] = { name: 'urgent', type: 'refusal' };
  const result = await model.decide(decisionInput);
  expect(result.answers.urgent).toEqual({ type: 'refusal' });
  expect(result.answers.severity).toMatchObject({ score: 0.25 });
});
it('accepts distinct boolean/string choices and reorders answers by name', async () => {
  const { model, payload } = decisionFixture('openai');
  payload.answers = [{ name: 'pick', type: 'choice', choice: false, confidence: 0.5, probabilities: [{ value: 'false', probability: 0.1 }, { value: false, probability: 0.9 }] }];
  const result = await model.decide({ input: 'Evidence', questions: { pick: { type: 'choice', instructions: 'Pick', choices: [{ value: false, description: 'Boolean' }, { value: 'false', description: 'String' }] } } });
  expect(result.answers.pick).toMatchObject({ choice: false });
});
it('validates inline images and refuses hosted URLs before I/O', async () => {
  const { model, fetcher } = decisionFixture('openai');
  await expect(model.decide({ ...decisionInput, input: [{ type: 'image', dataURL: 'https://example.com/image.png' }] })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await model.decide({ ...decisionInput, input: [{ type: 'text', text: 'Evidence' }, { type: 'image', dataURL: 'data:image/png;base64,AAAA' }] });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects duplicate answer names, wrong score labels, fractional token counts', async () => {
  for (const kind of ['duplicate', 'label', 'usage']) {
    const { model, payload } = decisionFixture('openai');
    if (kind === 'duplicate') payload.answers[1].name = 'urgent';
    if (kind === 'label') payload.answers[2].probabilities[0].label = 'wrong';
    if (kind === 'usage') payload.usage.total_tokens = 20.5;
    await expect(model.decide(decisionInput)).rejects.toThrow();
  }
});
it('rejects inconsistent weighted score and excessive response bodies', async () => {
  const { model, payload } = decisionFixture('openai');
  payload.answers[2].score = 0.9;
  await expect(model.decide(decisionInput)).rejects.toThrow();
  const huge = decisionFixture('openai', async () => new Response('x'.repeat(1048577)));
  await expect(huge.model.decide(decisionInput)).rejects.toThrow();
});
it('rejects malformed JSON without retaining echoed input', async () => {
  const { model } = decisionFixture('openai', async () => new Response('SECRET invalid JSON'));
  const error = await model.decide(decisionInput).catch(e => e);
  expect(error.message).not.toContain('SECRET');
  expect(error.cause).toBeUndefined();
});
