import { describe, expect, it, vi } from 'vitest';
import { createGemini } from '../src/index.js';
import type { DecisionInput } from '@zhivex-ai/core';

const input: DecisionInput = {
  input: 'A delivery arrived damaged.',
  questions: {
    damaged: { type: 'predicate', instructions: 'Is it damaged?', trueDescription: 'Broken', falseDescription: 'Intact' },
    route: { type: 'choice', instructions: [{ type: 'text', text: 'Choose ' }, { type: 'text', text: 'a team.' }], choices: [{ value: 'returns', description: 'Broken items' }, { value: 'support', description: '' }] },
    severity: { type: 'score', instructions: 'Rate damage.', levels: ['None', { label: 'Major', description: 'Cannot use' }] }
  }
};
function envelope(): any {
  return { answers: {
    damaged: { type: 'noul', noul: 0.9, confidence: 0.9 },
    route: { type: 'choice', choice: 'returns', probabilities: { returns: 0.8, support: 0.2 }, confidence: 0.8 },
    severity: { type: 'score', score: 0.75, probabilities: { '0': 0.25, '1': 0.75 }, legend: { '0': 'None', '1': 'Major: Cannot use' }, confidence: 0.75 }
  }, usage: { total_input_tokens: 25, total_output_tokens: 0, total_tokens: 25,
    input_tokens_by_modality: [{ modality: 'text', tokens: 10 }, { modality: 'image', tokens: 10 }, { modality: 'audio', tokens: 5 }] } };
}
function setup(payload = envelope()) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload, { headers: { 'x-request-id': 'req-test' } }));
  const model = createGemini({ apiKey: 'test-secret', fetch: fetcher }).decisionModel();
  return { model, fetcher, payload, body: () => JSON.parse(fetcher.mock.calls[0]![1]!.body as string) };
}

describe('Gemini Decisions', () => {
  it('uses the native endpoint and maps questions, confidence, rubric labels and modality usage', async () => {
    const { model, fetcher, body } = setup();
    const result = await model.decide(input);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe('https://generativelanguage.googleapis.com/v1beta/decisions');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'x-goog-api-key': 'test-secret' } });
    expect(body()).toEqual({ model: 'gemini-decision-1', input: input.input, questions: {
      damaged: { type: 'noul', instructions: 'Is it damaged?', criteria: { true_description: 'Broken', false_description: 'Intact' } },
      route: { type: 'choice', instructions: [{ type: 'text', text: 'Choose ' }, { type: 'text', text: 'a team.' }], criteria: { returns: 'Broken items', support: '' } },
      severity: { type: 'score', instructions: 'Rate damage.', criteria: ['None', 'Major: Cannot use'] }
    } });
    expect(result.answers.damaged).toEqual({ type: 'predicate', probability: 0.9, providerConfidence: 0.9 });
    expect(result.answers.severity).toEqual({ type: 'score', score: 0.75, providerConfidence: 0.75,
      probabilities: [{ value: 0, label: 'None', probability: 0.25 }, { value: 1, label: 'Major', probability: 0.75 }] });
    expect(result.usage).toEqual({ inputTokens: 25, outputTokens: 0, totalTokens: 25,
      inputTokensByModality: [{ modality: 'text', tokens: 10 }, { modality: 'image', tokens: 10 }, { modality: 'audio', tokens: 5 }] });
    expect(result.provenance).toMatchObject({ provider: 'gemini', modelId: 'gemini-decision-1', protocol: 'gemini.decisions' });
    expect(result.requestId).toBe('req-test');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
  it('sends mixed inline media, HTTPS URLs and Files API URIs without downloading or transcribing', async () => {
    const { model, body, fetcher } = setup();
    await model.decide({ ...input, input: [
      { type: 'text', text: 'Inspect all evidence.\n' },
      { type: 'image', data: 'AAAA', mimeType: 'image/heic', resolution: 'ultra_high' },
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      { type: 'audio', uri: 'https://example.com/audio.mp3?signature=test', mimeType: 'audio/mp3' },
      { type: 'video', data: 'AAAA', mimeType: 'video/mp4', resolution: 'medium' },
      { type: 'video', uri: 'https://generativelanguage.googleapis.com/v1beta/files/video', mimeType: 'video/webm', resolution: 'high' },
      { type: 'document', data: 'AAAA', mimeType: 'application/pdf' },
      { type: 'document', uri: 'https://example.com/invoice.pdf', mimeType: 'application/pdf' }
    ] });
    expect(body().input).toEqual([
      { type: 'text', text: 'Inspect all evidence.\n' },
      { type: 'image', data: 'AAAA', mime_type: 'image/heic', resolution: 'ultra_high' },
      { type: 'audio', data: 'AAAA', mime_type: 'audio/wav' },
      { type: 'audio', uri: 'https://example.com/audio.mp3?signature=test', mime_type: 'audio/mp3' },
      { type: 'video', data: 'AAAA', mime_type: 'video/mp4', resolution: 'medium' },
      { type: 'video', uri: 'https://generativelanguage.googleapis.com/v1beta/files/video', mime_type: 'video/webm', resolution: 'high' },
      { type: 'document', data: 'AAAA', mime_type: 'application/pdf' },
      { type: 'document', uri: 'https://example.com/invoice.pdf', mime_type: 'application/pdf' }
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('supports legacy dataURL images and omitted choice descriptions', async () => {
    const { model, body } = setup();
    await model.decide({ ...input, input: [{ type: 'image', dataURL: 'data:image/png;base64,AAAA', detail: 'low' }],
      questions: { ...input.questions, route: { type: 'choice', instructions: 'Choose.', choices: [{ value: 'returns' }, { value: 'support' }] } } });
    expect(body().input[0]).toEqual({ type: 'image', data: 'AAAA', mime_type: 'image/png', resolution: 'low' });
    expect(body().questions.route.criteria).toEqual({ returns: '', support: '' });
  });
  it('accepts inline media larger than the legacy 1 MiB snapshot limit', async () => {
    const { model, body } = setup();
    const data = 'AAAA'.repeat(350000);
    await model.decide({ ...input, input: [{ type: 'document', data, mimeType: 'application/pdf' }] });
    expect(body().input[0].data.length).toBe(data.length);
  });
  it.each([
    { type: 'audio', data: 'AAAA', mimeType: 'image/png' },
    { type: 'audio', data: 'AAAA', mimeType: 'audio/unknown' },
    { type: 'audio', data: 'AAAA', uri: 'https://example.com/a', mimeType: 'audio/wav' },
    { type: 'audio', data: 'AAA!', mimeType: 'audio/wav' },
    { type: 'audio', data: '', mimeType: 'audio/wav' },
    { type: 'document', data: 'AAAA', mimeType: 'application/octet-stream' },
    { type: 'document', data: 'AAAA', mimeType: 'application/pdf', resolution: 'low' },
    { type: 'video', data: 'AAAA', mimeType: 'video/mp4', resolution: 'ultra_high' },
    { type: 'image', uri: 'http://example.com/a', mimeType: 'image/png' },
    { type: 'video', uri: 'gs://bucket/a', mimeType: 'video/mp4' },
    { type: 'video', uri: 'https://www.youtube.com/watch?v=a', mimeType: 'video/mp4' },
    { type: 'audio', uri: 'https://user:password@example.com/a', mimeType: 'audio/wav' },
    { type: 'image', url: 'https://example.com/a' },
    { type: 'json', data: { ticket: 'test' } },
    { role: 'user', content: 'history' }
  ])('rejects unsupported/malformed media before I/O: %j', async part => {
    const { model, fetcher } = setup();
    await expect(model.decide({ ...input, input: [part] as any })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('enforces question IDs, count, option keys, score limits and text-only instructions', () => {
    const { model, fetcher } = setup();
    const predicate = { type: 'predicate' as const, instructions: 'Check.' };
    model.validate({ input: 'x', questions: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`q${i}`, predicate])) });
    for (const questions of [
      Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`q${i}`, predicate])),
      { ['a'.repeat(65)]: predicate }, { 'bad key': predicate },
      { q: { ...predicate, instructions: [{ type: 'image', dataURL: 'data:image/png;base64,AAAA' }] } },
      { q: { type: 'choice', instructions: 'Choose.', choices: [{ value: true }, { value: false }] } },
      { q: { type: 'choice', instructions: 'Choose.', choices: [{ value: 'bad\u00a0key' }, { value: 'good' }] } },
      { q: { type: 'score', instructions: 'Rate.', levels: Array.from({ length: 256 }, (_, i) => `Level ${i}`) } }
    ]) expect(() => model.validate({ input: 'x', questions } as any)).toThrow();
    for (const option of [{ promptCacheKey: 'key' }, { safetyIdentifier: 'user' }, { stream: true }]) {
      expect(() => model.validate({ ...input, ...option })).toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['missing', 'extra', 'wrongType', 'refusal', 'confidence', 'predicate', 'distribution', 'choice', 'legend', 'score', 'usage', 'output', 'modality'])(
    'rejects malformed %s responses', async kind => {
      const { model, payload } = setup();
      if (kind === 'missing') delete payload.answers.route;
      if (kind === 'extra') payload.answers.extra = payload.answers.route;
      if (kind === 'wrongType') payload.answers.damaged.type = 'choice';
      if (kind === 'refusal') payload.answers.damaged = { type: 'refusal' };
      if (kind === 'confidence') payload.answers.damaged.confidence = 1.1;
      if (kind === 'predicate') payload.answers.damaged.noul = 1;
      if (kind === 'distribution') payload.answers.route.probabilities.returns = 0.1;
      if (kind === 'choice') payload.answers.route.choice = 'unknown';
      if (kind === 'legend') payload.answers.severity.legend['1'] = 'Wrong level';
      if (kind === 'score') payload.answers.severity.score = 0.1;
      if (kind === 'usage') payload.usage.total_input_tokens = -1;
      if (kind === 'output') payload.usage.total_output_tokens = 1;
      if (kind === 'modality') payload.usage.input_tokens_by_modality[0].tokens = 0;
      await expect(model.decide(input)).rejects.toThrow(/Invalid/);
    });
  it.each([400, 401, 429, 500, 503])('preserves HTTP %s without retries or leaking provider errors', async status => {
    const fetcher = vi.fn(async () => new Response('secret evidence and API key', { status }));
    const model = createGemini({ apiKey: 'test-secret', fetch: fetcher }).decisionModel();
    await expect(model.decide(input)).rejects.toMatchObject({ status, message: `Decision request failed (${status}).` });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('cancels before sending and bounds an uncooperative transport', async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const model = createGemini({ apiKey: 'test-secret', fetch: fetcher }).decisionModel();
    await expect(model.decide({ ...input, abortSignal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(model.decide({ ...input, timeoutMs: 10 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
});
