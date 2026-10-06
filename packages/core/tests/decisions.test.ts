import { describe, it, expect, vi } from 'vitest';
import { snapshotDecision, validateDecisionAnswers } from '../src/decisions.js';
import { decisionFixture, decisionInput } from './fixtures/decision-contract.js';

for (const provider of ['openai', 'qwen'] as const) describe(`${provider} portable DecisionModel conformance`, () => {
  it('maps all three questions and preserves fractional scores and provider confidence', async () => {
    const { model, fetcher } = decisionFixture(provider);
    const r = await model.decide(decisionInput);
    expect(r.answers.urgent).toEqual({ type: 'predicate', probability: 0.2 });
    expect(r.answers.severity).toMatchObject({ score: 0.25, providerConfidence: 0.4 });
    expect(r.provenance).toMatchObject({ provider, modelId: model.modelId, endpoint: model.endpoint });
    expect(r.usage.inputTokens).toBe(20);
    expect(r.answers.urgent).not.toHaveProperty('providerConfidence');
    const args = vi.mocked(fetcher).mock.calls[0]!;
    const body = JSON.parse(args[1]!.body as string);
    expect(args[1]).toMatchObject({ redirect: 'error', method: 'POST' });
    if (provider === 'qwen') {
      expect(body.state).toBe(decisionInput.input);
      expect(body.questions.urgent.type).toBe('noul');
      expect(r).toMatchObject({ requestId: 'request-test', latencyMs: 1.2 });
    } else {
      expect(body.input).toBe(decisionInput.input);
      expect(body.questions[0]).toMatchObject({ name: 'urgent', type: 'predicate' });
      expect(r).not.toHaveProperty('latencyMs');
      expect(r).not.toHaveProperty('requestId');
    }
  });
  it.each(['missing', 'unknown', 'type', 'probability', 'distribution', 'score', 'confidence', 'model', 'usage'] as const)('rejects malformed %s', async kind => {
    const { model, payload } = decisionFixture(provider);
    const predicate = provider === 'openai' ? payload.answers[0] : payload.answers.urgent;
    const choice = provider === 'openai' ? payload.answers[1] : payload.answers.route;
    const score = provider === 'openai' ? payload.answers[2] : payload.answers.severity;
    if (kind === 'missing') { if (provider === 'openai') payload.answers.pop(); else delete payload.answers.urgent; }
    if (kind === 'unknown') { if (provider === 'openai') predicate.name = 'unknown'; else { payload.answers.unknown = predicate; delete payload.answers.urgent; } }
    if (kind === 'type') predicate.type = 'score';
    if (kind === 'probability') predicate[provider === 'openai' ? 'probability' : 'noul'] = 2;
    if (kind === 'distribution') { if (provider === 'openai') choice.probabilities[0].probability = 0; else choice.probabilities.billing = 0; }
    if (kind === 'score') score.score = -1;
    if (kind === 'confidence') choice.confidence = 2;
    if (kind === 'model') payload.model = 'wrong';
    if (kind === 'usage') payload.usage.input_tokens = -1;
    await expect(model.decide(decisionInput)).rejects.toThrow();
  });
  it('validates before network and rejects undeclared retries', async () => {
    const { model, fetcher } = decisionFixture(provider);
    for (const input of [{ ...decisionInput, questions: {} }, { ...decisionInput, timeoutMs: -1 }, { ...decisionInput, maxRetries: 1 }, { ...decisionInput, input: 'a'.repeat(1048577) }]) await expect(model.decide(input)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not retry HTTP errors and sanitizes provider bodies', async () => {
    const fetcher = vi.fn(async () => new Response('SECRET evidence', { status: 503 }));
    const { model } = decisionFixture(provider, fetcher);
    await expect(model.decide(decisionInput)).rejects.toMatchObject({ status: 503, responseBody: undefined, cause: undefined });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('sanitizes custom transport errors', async () => {
    const { model } = decisionFixture(provider, vi.fn(async () => { throw new Error('SECRET'); }));
    await expect(model.decide(decisionInput)).rejects.toMatchObject({ message: 'Decision operation failed.' });
  });
  it('pre-abort never sends and does not expose the abort reason', async () => {
    const { model, fetcher } = decisionFixture(provider);
    const c = new AbortController(); c.abort('SECRET');
    await expect(model.decide({ ...decisionInput, abortSignal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('deadline settles even when fetch ignores abort', async () => {
    const { model } = decisionFixture(provider, vi.fn(() => new Promise(() => {})));
    await expect(model.decide({ ...decisionInput, timeoutMs: 5 })).rejects.toMatchObject({ name: 'TimeoutError' });
  });
  it('snapshots questions against caller mutation', async () => {
    const fixture = decisionFixture(provider);
    const input = structuredClone(decisionInput);
    const pending = fixture.model.decide(input);
    (input.questions as any).urgent.type = 'score';
    expect((await pending).answers.urgent.type).toBe('predicate');
  });
});

describe('decision validators', () => {
  it('rejects unserializable and non-finite evidence', () => {
    expect(() => snapshotDecision({ ...decisionInput, input: { secret: NaN } as any })).toThrow();
  });
  it('uses exact typed values, quantities, labels and distributions', () => {
    const q = { x: { type: 'choice' as const, instructions: 'Pick', choices: [{ value: true, description: 'Boolean' }, { value: 'true', description: 'String' }] } };
    expect(() => validateDecisionAnswers({ x: { type: 'choice', choice: true, probabilities: [{ value: true, probability: 0.6 }, { value: 'true', probability: 0.4 }] } }, q, true)).not.toThrow();
    expect(() => validateDecisionAnswers({ x: { type: 'choice', choice: true, probabilities: [{ value: true, probability: 0.6 }, { value: true, probability: 0.4 }] } }, q, true)).toThrow();
  });
});
