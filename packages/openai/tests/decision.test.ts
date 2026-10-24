import { createOpenAIDecisionModel } from "../src/decision.js";
import { it, expect, vi } from 'vitest';
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

it('normalizes only trailing endpoint slashes while preserving long internal paths', () => {
  const base = 'https://decision.example.com/' + '/'.repeat(20_000) + 'v1';
  const model = createOpenAIDecisionModel('gpt-6-luna', { apiKey: 'offline-test', baseURL: base + '///' });
  expect(model.endpoint).toBe(base + '/decisions');
});

it('maps GA evidence, question media, cache controls and safety identifiers', async () => {
  const { model, fetcher, payload } = decisionFixture('openai');
  payload.answers[1] = { name: 'route', type: 'choice', choice: false, confidence: 0.6, probabilities: [{ value: 'billing', probability: 0.3 }, { value: false, probability: 0.7 }] };
  await model.decide({
    input: [
      { role: 'developer', content: [{ type: 'text', text: 'Policy', promptCacheBreakpoint: { mode: 'explicit' } }] },
      { role: 'user', content: [
        { type: 'text', text: 'Ticket' },
        { type: 'json', data: { ticket: { body: 'Refund' }, order: { charges: [49, 49] } } },
        { type: 'image', url: 'https://cdn.example.com/receipt.png', detail: 'high' }
      ] },
      { type: 'function_call', name: 'lookup', arguments: '{"id":"1"}', callId: 'call_1' },
      { type: 'function_call_output', callId: 'call_1', output: 'paid' }
    ],
    questions: {
      urgent: { type: 'predicate', instructions: [{ type: 'text', text: 'Duplicate?' }, { type: 'image', dataURL: 'data:image/png;base64,AAAA', detail: 'low' }] },
      route: { type: 'choice', instructions: 'Choose', choices: [{ value: 'billing' }, { value: false }] },
      severity: { type: 'score', instructions: 'Rate', levels: [{ label: 'Low', description: 'No action' }, { label: 'High', description: 'Review' }] }
    },
    promptCacheKey: 'tenant-1',
    promptCacheOptions: { mode: 'explicit', ttl: '30m' },
    safetyIdentifier: 'user-123'
  });
  const body = JSON.parse(vi.mocked(fetcher).mock.calls[0]![1]!.body as string);
  expect(body).toMatchObject({
    model: 'gpt-6-luna',
    prompt_cache_key: 'tenant-1',
    prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    safety_identifier: 'user-123'
  });
  expect(body.input[0].content[0]).toEqual({ type: 'input_text', text: 'Policy', prompt_cache_breakpoint: { mode: 'explicit' } });
  expect(body.input[1].content[1]).toEqual({ type: 'input_json', data: { ticket: { body: 'Refund' }, order: { charges: [49, 49] } } });
  expect(body.input[1].content[2]).toEqual({ type: 'input_image', image_url: 'https://cdn.example.com/receipt.png', detail: 'high' });
  expect(body.input[2]).toEqual({ type: 'function_call', name: 'lookup', arguments: '{"id":"1"}', call_id: 'call_1' });
  expect(body.questions[0].instructions[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'low' });
  expect(body.questions[1].choices).toEqual([{ value: 'billing' }, { value: false }]);
  expect(body.questions[2].levels).toEqual([{ label: 'Low', description: 'No action' }, { label: 'High', description: 'Review' }]);
});
it('accepts a dated GA snapshot and maps cache usage without adding it to the input total', async () => {
  const { model, payload } = decisionFixture('openai');
  payload.model = 'gpt-6-luna-2026-10-22';
  payload.usage = { input_tokens: 20, output_tokens: 0, total_tokens: 20, input_tokens_details: { cached_tokens: 12, cache_write_tokens: 4 }, output_tokens_details: { reasoning_tokens: 0 } };
  const result = await model.decide(decisionInput);
  expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 0, totalTokens: 20, cachedInputTokens: 12, cacheWriteTokens: 4, reasoningTokens: 0 });
  payload.model = 'gpt-6-luna-preview';
  await expect(model.decide(decisionInput)).rejects.toThrow();
});
it('rejects GA fields that are outside the published decision limits before network', async () => {
  const { model, fetcher } = decisionFixture('openai');
  const image = { type: 'image' as const, url: 'https://cdn.example.com/a.png' };
  await expect(model.decide({ ...decisionInput, input: [{ type: 'image', url: 'http://user:pass@cdn.example.com/a.png' }] })).rejects.toThrow();
  await expect(model.decide({ ...decisionInput, input: [{ role: 'user', content: [image] }, { type: 'function_call_output', callId: 'missing', output: 'x' }] })).rejects.toThrow();
  await expect(model.decide({ ...decisionInput, safetyIdentifier: 'x'.repeat(65) })).rejects.toThrow();
  await expect(model.decide({ ...decisionInput, promptCacheOptions: { ttl: '12h' } as never })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('keeps decisionModel as the stable alias of experimentalDecisionModel', () => {
  const { adapter } = decisionFixture('openai');
  expect(adapter.decisionModel().modelId).toBe('gpt-6-luna');
  expect(adapter.experimentalDecisionModel().endpoint).toBe(adapter.decisionModel().endpoint);
});
it('enforces the image-count boundary during validation and decide before network', async () => {
  const { model, fetcher } = decisionFixture('openai');
  const image = { type: 'image' as const, dataURL: 'data:image/png;base64,AAAA' };
  const tooMany = { ...decisionInput, input: Array.from({ length: 129 }, () => image) };
  expect(() => model.validate(tooMany)).toThrow();
  await expect(model.decide(tooMany)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  const boundary = { ...decisionInput, input: [{ type: 'text' as const, text: 'Evidence' }, ...Array.from({ length: 128 }, () => image)] };
  expect(() => model.validate(boundary)).not.toThrow();
  await model.decide(boundary);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
