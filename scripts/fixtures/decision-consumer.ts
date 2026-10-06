import type { DecisionModel, DecisionInput, DecisionAnswer } from '@zhivex-ai/sdk';
import type { DecisionModel as ExperimentalDecisionModel } from '@zhivex-ai/sdk/experimental';
import { createOpenAI } from '@zhivex-ai/openai';
import { createQwen } from '@zhivex-ai/qwen';
import { createGateway } from '@zhivex-ai/gateway';

export function portableDecisionConsumer(apiKey: string) {
  const openai: DecisionModel = createOpenAI({ apiKey }).experimentalDecisionModel();
  const qwen: ExperimentalDecisionModel = createQwen({ apiKey }).experimentalDecisionModel();
  const gateway = createGateway({ adapters: {}, decisions: { primary: { model: openai }, backup: { model: qwen } } });
  const input: DecisionInput = { input: 'Synthetic ticket', questions: { urgent: { type: 'predicate', instructions: 'Is it urgent?' } } };
  return gateway.decide({ ...input, primary: 'primary', alternatives: ['backup'], maxAttempts: 2, fallbackOn: [503] });
}
export function interpret(answer: DecisionAnswer): number | undefined {
  if (answer.type === 'predicate') return answer.probability;
  if (answer.type === 'score') return answer.score;
  return undefined;
}
