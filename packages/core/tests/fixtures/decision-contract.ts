import { vi } from 'vitest';
import { createOpenAI } from '../../../openai/src/index.js';
import { createQwen } from '../../../qwen/src/index.js';
import type { DecisionInput } from '../../src/decisions.js';
export const decisionInput: DecisionInput = {
  input: 'Synthetic support ticket.',
  questions: {
    urgent: { type: 'predicate', instructions: 'Is it urgent?' },
    route: { type: 'choice', instructions: 'Choose team.', choices: [{ value: 'billing', description: 'Invoices' }, { value: 'support', description: 'Failures' }] },
    severity: { type: 'score', instructions: 'Rate severity.', levels: ['Low', 'High'] }
  }
};
export const openAIEnvelope = () => ({
  model: 'gpt-6-luna', answers: [
    { name: 'urgent', type: 'predicate', probability: 0.2 },
    { name: 'route', type: 'choice', choice: 'billing', confidence: 0.6, probabilities: [{ value: 'billing', probability: 0.7 }, { value: 'support', probability: 0.3 }] },
    { name: 'severity', type: 'score', score: 0.25, confidence: 0.4, probabilities: [{ value: 0, label: 'Low', probability: 0.75 }, { value: 1, label: 'High', probability: 0.25 }] }
  ], usage: { input_tokens: 20, output_tokens: 0, total_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
});
export const qwenEnvelope = () => ({
  model: 'decision-model-preview', request_id: 'request-test', latency_ms: 1.2,
  answers: {
    urgent: { type: 'noul', noul: 0.2 },
    route: { type: 'choice', choice: 'billing', confidence: 0.6, probabilities: { billing: 0.7, support: 0.3 } },
    severity: { type: 'score', score: 0.25, confidence: 0.4, probabilities: { '0': 0.75, '1': 0.25 }, legend: { '0': 'Low', '1': 'High' } }
  }, usage: { input_tokens: 20 }
});
export function decisionFixture(provider: 'openai' | 'qwen', customFetch?: typeof fetch) {
  const payload: any = provider === 'openai' ? openAIEnvelope() : qwenEnvelope();
  const fetcher = customFetch ?? vi.fn(async () => Response.json(payload));
  const options = { apiKey: 'offline-test', fetch: fetcher, baseURL: 'https://decision.example.com/v1' };
  const adapter = provider === 'openai' ? createOpenAI(options) : createQwen(options);
  return { payload, fetcher, model: adapter.experimentalDecisionModel!(), adapter };
}
