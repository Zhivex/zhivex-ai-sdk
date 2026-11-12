import { expect, it } from 'vitest';
import { snapshotDecision, validateDecision, validateDecisionAnswers, type DecisionCapabilities, type DecisionInput } from '../src/decisions.js';
import { decisionFixture } from './fixtures/decision-contract.js';

const capabilities: DecisionCapabilities = { questionTypes: ['predicate'], inputTypes: ['text', 'image', 'audio', 'video', 'document'], choiceValueTypes: ['string'], perQuestionRefusal: false, textParts: true, mediaInput: true, predicateDescriptions: true };
const input: DecisionInput = { input: [{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }], questions: { q: { type: 'predicate', instructions: 'Is there speech?' } } };
it('gates new media blocks by capability and preserves their snapshot', () => {
  for (const part of [
    { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
    { type: 'video', uri: 'https://example.com/a.mp4', mimeType: 'video/mp4', resolution: 'medium' },
    { type: 'document', data: 'AAAA', mimeType: 'application/pdf' },
    { type: 'image', uri: 'https://example.com/a.heic', mimeType: 'image/heic', resolution: 'ultra_high' }
  ] as const) {
    const request = { ...input, input: [part] };
    expect(() => validateDecision(request, capabilities)).not.toThrow();
    expect(snapshotDecision(request)).toEqual(request);
    expect(() => validateDecision(request, { ...capabilities, mediaInput: false })).toThrow();
    expect(() => validateDecision(request, { ...capabilities, inputTypes: ['text'] })).toThrow();
  }
});
it('does not widen OpenAI or Qwen accepted inputs when shared types grow', () => {
  for (const provider of ['openai', 'qwen'] as const) {
    const { model, fetcher } = decisionFixture(provider);
    expect(() => model.validate(input)).toThrow();
    expect(() => model.validate({ ...input, input: 'text', questions: { q: { type: 'predicate', instructions: 'Check.', trueDescription: 'yes' } } })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  }
});
it('checks confidence on predicates and keeps legacy answers valid', () => {
  expect(() => validateDecisionAnswers({ q: { type: 'predicate', probability: 0.9 } }, input.questions, false)).not.toThrow();
  expect(() => validateDecisionAnswers({ q: { type: 'predicate', probability: 0.9, providerConfidence: 0.9 } }, input.questions, false)).not.toThrow();
  for (const providerConfidence of [-1, 2, NaN, '0.9']) expect(() => validateDecisionAnswers({ q: { type: 'predicate', probability: 0.9, providerConfidence } }, input.questions, false)).toThrow();
});
it('uses explicit snapshot budgets while retaining the old default', () => {
  const request = { ...input, input: 'x'.repeat(1024 * 1024) };
  expect(() => snapshotDecision(request)).toThrow();
  expect(snapshotDecision(request, 2 * 1024 * 1024).input).toBe(request.input);
  expect(() => validateDecision(request, { ...capabilities, maxInputBytes: 2 * 1024 * 1024 })).not.toThrow();
  for (const limit of [0, -1, NaN, Infinity, 151 * 1024 * 1024]) expect(() => snapshotDecision(input, limit)).toThrow();
});

it.each(['AAAA', 'AAA=', 'AA=='])('accepts legacy base64 image padding: %s', data => {
  for (const mime of ['png', 'jpeg', 'webp', 'gif']) {
    expect(() => validateDecision({ ...input, input: [{ type: 'image', dataURL: `data:image/${mime};base64,${data}` }] }, capabilities)).not.toThrow();
  }
});
it.each(['', 'A', 'AAA', 'AAAA=', 'A===', '====', 'AA=A', 'AA!A', 'AAAA\n', 'AAAA AAA', 'AAAA,AAAA'])('rejects malformed base64 in both image representations: %j', data => {
  for (const part of [
    { type: 'image' as const, dataURL: `data:image/png;base64,${data}` },
    { type: 'image' as const, data, mimeType: 'image/png' }
  ]) expect(() => validateDecision({ ...input, input: [part] }, capabilities)).toThrow();
});
it.each(['data:image/svg+xml;base64,AAAA', 'data:image/png,AAAA', 'data:image/png;base64;extra,AAAA', 'prefix:data:image/png;base64,AAAA'])('preserves the legacy data URL MIME and prefix restrictions: %s', dataURL => {
  expect(() => validateDecision({ ...input, input: [{ type: 'image', dataURL }] }, capabilities)).toThrow();
});
