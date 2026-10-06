import { describe, it, expect, vi } from 'vitest';
import { createGateway } from '../src/index.js';
import { decisionFixture, decisionInput, openAIEnvelope } from '../../core/tests/fixtures/decision-contract.js';

function setup(status = 503) {
  const firstFetch = vi.fn(async () => new Response('SECRET', { status }));
  const first = decisionFixture('openai', firstFetch);
  const second = decisionFixture('qwen');
  const gateway = createGateway({ adapters: {}, decisions: { primary: { model: first.model, reserveUSD: 0.1 }, backup: { model: second.model, reserveUSD: 0.2 } } });
  return { gateway, first, second, firstFetch };
}
const request = { ...decisionInput, primary: 'primary', alternatives: ['backup'], maxAttempts: 2, fallbackOn: [503] as const };
describe('explicit decision gateway', () => {
  it('falls back only to the selected compatible destination with provenance and reservations', async () => {
    const { gateway, firstFetch, second } = setup();
    const result = await gateway.decide({ ...request, maxReservedUSD: 0.3 });
    expect(result.provenance.provider).toBe('qwen');
    expect(result.routing).toMatchObject({ target: 'backup', attempts: 2 });
    expect(result.routing.reservedUSD).toBe(0.3);
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(second.fetcher).toHaveBeenCalledTimes(1);
  });
  it('has no implicit fallback or retry', async () => {
    const { gateway, firstFetch, second } = setup();
    await expect(gateway.decide({ ...decisionInput, primary: 'primary', alternatives: ['backup'] })).rejects.toMatchObject({ status: 503 });
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(second.fetcher).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 408, 422])('does not fall back on status %s', async status => {
    const { gateway, second } = setup(status);
    await expect(gateway.decide(request)).rejects.toMatchObject({ status });
    expect(second.fetcher).not.toHaveBeenCalled();
  });
  it('requires an explicit retryable status even when multiple attempts are allowed', async () => {
    const { gateway, second } = setup(429);
    await expect(gateway.decide(request)).rejects.toMatchObject({ status: 429 });
    expect(second.fetcher).not.toHaveBeenCalled();
    expect((await gateway.decide({ ...request, fallbackOn: [429] })).routing.target).toBe('backup');
  });
  it('stops after a partial refusal', async () => {
    const first = decisionFixture('openai'); const second = decisionFixture('qwen');
    first.payload.answers[0] = { name: 'urgent', type: 'refusal' };
    const gateway = createGateway({ adapters: {}, decisions: { primary: { model: first.model }, backup: { model: second.model } } });
    const result = await gateway.decide(request);
    expect(result.answers.urgent).toEqual({ type: 'refusal' });
    expect(result.routing.attempts).toBe(1);
    expect(second.fetcher).not.toHaveBeenCalled();
  });
  it('preflights capabilities of all alternatives before sending any evidence', async () => {
    const { gateway, firstFetch, second } = setup();
    await expect(gateway.decide({ ...request, input: [{ type: 'image', dataURL: 'data:image/png;base64,AAAA' }] })).rejects.toThrow();
    expect(firstFetch).not.toHaveBeenCalled(); expect(second.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { allowedProviders: ['openai'] }, { allowedEndpoints: ['https://other.example.com'] }, { requirePerQuestionRefusal: true },
    { maxAttempts: 0 }, { maxAttempts: 3 }, { alternatives: ['unknown'] }, { alternatives: ['primary'] }, { maxReservedUSD: NaN }, { maxRetries: 1 }
  ])('preflights restrictions and routing controls %j', async controls => {
    const { gateway, firstFetch } = setup();
    await expect(gateway.decide({ ...request, ...controls })).rejects.toThrow();
    expect(firstFetch).not.toHaveBeenCalled();
  });
  it('charges failed attempts against reservation budget and blocks over-budget fallback', async () => {
    const { gateway, firstFetch, second } = setup();
    await expect(gateway.decide({ ...request, maxReservedUSD: 0.2 })).rejects.toThrow();
    expect(firstFetch).toHaveBeenCalledTimes(1); expect(second.fetcher).not.toHaveBeenCalled();
  });
  it('blocks a first attempt over budget and unknown cost before network', async () => {
    const { gateway, first, firstFetch } = setup();
    await expect(gateway.decide({ ...request, maxReservedUSD: 0.01 })).rejects.toThrow();
    const unknown = createGateway({ adapters: {}, decisions: { primary: { model: first.model } } });
    await expect(unknown.decide({ ...decisionInput, primary: 'primary', maxReservedUSD: 1 })).rejects.toThrow();
    expect(firstFetch).not.toHaveBeenCalled();
  });
  it('does not fall back for malformed responses or transport errors', async () => {
    for (const fetcher of [vi.fn(async () => Response.json({ ...openAIEnvelope(), answers: [] })), vi.fn(async () => { throw new Error('SECRET'); })]) {
      const first = decisionFixture('openai', fetcher); const second = decisionFixture('qwen');
      const gateway = createGateway({ adapters: {}, decisions: { primary: { model: first.model }, backup: { model: second.model } } });
      await expect(gateway.decide(request)).rejects.toThrow();
      expect(second.fetcher).not.toHaveBeenCalled();
    }
  });
  it('shares one deadline and stops fallback after abort', async () => {
    const first = decisionFixture('openai', vi.fn(() => new Promise(() => {}))); const second = decisionFixture('qwen');
    const gateway = createGateway({ adapters: {}, timeoutMs: 5, decisions: { primary: { model: first.model }, backup: { model: second.model } } });
    await expect(gateway.decide(request)).rejects.toMatchObject({ name: 'TimeoutError' });
    const controller = new AbortController();
    const pending = gateway.decide({ ...request, timeoutMs: 1000, abortSignal: controller.signal }); controller.abort('SECRET');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(second.fetcher).not.toHaveBeenCalled();
  });
  it('keeps language routing APIs available without registering decisions', async () => {
    const gateway = createGateway({ adapters: {} });
    expect(gateway.generate).toBeTypeOf('function'); expect(gateway.streamText).toBeTypeOf('function');
    await expect(gateway.decide({ ...decisionInput, primary: 'primary' })).rejects.toThrow('Unknown decision destination');
  });
});

it('checks advertised capabilities even for a custom no-op validator', async () => {
  const fixture = decisionFixture('openai');
  const model = { ...fixture.model, capabilities: { ...fixture.model.capabilities, inputTypes: [] }, validate: () => {} };
  const gateway = createGateway({ adapters: {}, decisions: { primary: { model } } });
  await expect(gateway.decide({ ...decisionInput, primary: 'primary' })).rejects.toThrow();
  expect(fixture.fetcher).not.toHaveBeenCalled();
});

it.each([
  [0.1, 0.2, 0.3, true],
  [1e-20, 2e-20, 3e-20, true],
  [1e20, 2e20, 3e20, true],
  [0.1, 0.20000000000000004, 0.3, false],
  [1e-20, 2.0000000000000002e-20, 3e-20, false],
  [0, Number.MIN_VALUE, 0, false],
  [1, 1e-16, 1, false]
])('compares exact decimal reservations %s + %s against %s', async (primary, backup, ceiling, allowed) => {
  const first = decisionFixture('openai', vi.fn(async () => new Response('', { status: 503 })));
  const second = decisionFixture('qwen');
  const gateway = createGateway({ adapters: {}, decisions: { primary: { model: first.model, reserveUSD: primary as number }, backup: { model: second.model, reserveUSD: backup as number } } });
  const pending = gateway.decide({ ...request, maxReservedUSD: ceiling as number });
  if (allowed) expect((await pending).routing.reservedUSD).toBe(ceiling);
  else await expect(pending).rejects.toThrow();
  expect(second.fetcher).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it('reports a conservative reservation when the exact decimal sum is between numbers', async () => {
  const first = decisionFixture('openai', vi.fn(async () => new Response('', { status: 503 })));
  const second = decisionFixture('qwen');
  const gateway = createGateway({ adapters: {}, decisions: { primary: { model: first.model, reserveUSD: 1 }, backup: { model: second.model, reserveUSD: 1e-16 } } });
  const result = await gateway.decide(request);
  expect(result.routing.reservedUSD).toBe(1.0000000000000002);
  expect(second.fetcher).toHaveBeenCalledTimes(1);
});
