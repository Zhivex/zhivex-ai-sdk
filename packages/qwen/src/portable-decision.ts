import { experimentalDecisionHelpers, type DecisionModel, type DecisionCapabilities, type DecisionInput, type DecisionAnswer } from '@zhivex-ai/core/provider';
const invalidDecision: typeof experimentalDecisionHelpers.invalidDecision = experimentalDecisionHelpers.invalidDecision;
const snapshotDecision: typeof experimentalDecisionHelpers.snapshotDecision = experimentalDecisionHelpers.snapshotDecision;
const validateDecision: typeof experimentalDecisionHelpers.validateDecision = experimentalDecisionHelpers.validateDecision;
const validateDecisionAnswers: typeof experimentalDecisionHelpers.validateDecisionAnswers = experimentalDecisionHelpers.validateDecisionAnswers;
const decisionOperation: typeof experimentalDecisionHelpers.decisionOperation = experimentalDecisionHelpers.decisionOperation;
import { createQwenDecisionModel, type QwenDecisionModelOptions, type QwenDecisionQuestions } from './decision.js';

const capabilities: DecisionCapabilities = Object.freeze({
  questionTypes: Object.freeze(['predicate', 'choice', 'score'] as const),
  inputTypes: Object.freeze(['text'] as const), choiceValueTypes: Object.freeze(['string'] as const), perQuestionRefusal: false, textParts: false
});
export function createPortableQwenDecisionModel(modelId: string, options: QwenDecisionModelOptions): DecisionModel {
  const native = createQwenDecisionModel(modelId, options);
  const endpoint = `${options.baseURL.replace(/\/+$/, '')}/systemone`;
  const validate = (input: DecisionInput) => {
    validateDecision(input, capabilities);
    const snapshot = snapshotDecision(input);
    const questions: QwenDecisionQuestions = Object.fromEntries(Object.entries(snapshot.questions).map(([id, q]) => [id,
      q.type === 'predicate' ? { type: 'noul', instructions: q.instructions }
      : q.type === 'choice' ? { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(q.choices.map(c => [c.value, c.description])) }
      : { type: 'score', instructions: q.instructions, criteria: q.levels }
    ]));
    if (new TextEncoder().encode(JSON.stringify({ model: modelId, state: snapshot.input, questions })).byteLength > 1024 * 1024) invalidDecision();
    return { snapshot, questions };
  };
  return Object.freeze({
    provider: 'qwen', modelId, endpoint, capabilities, validate: (input: DecisionInput) => { validate(input); },
    async decide(input: DecisionInput) {
      const { snapshot, questions } = validate(input);
      return decisionOperation(snapshot, async signal => {
        const result = await native.decide({ state: snapshot.input as string, questions, abortSignal: signal, timeoutMs: snapshot.timeoutMs, maxRetries: 0 });
        const answers: Record<string, DecisionAnswer> = Object.fromEntries(Object.entries(result.answers).map(([id, a]) => [id,
          a.type === 'noul' ? { type: 'predicate', probability: a.noul }
          : a.type === 'choice' ? { type: 'choice', choice: a.choice, providerConfidence: a.confidence, probabilities: Object.entries(a.probabilities).map(([value, probability]) => ({ value, probability })) }
          : { type: 'score', score: a.score, providerConfidence: a.confidence, probabilities: Object.entries(a.probabilities).map(([value, probability]) => ({ value: Number(value), label: a.legend[value]!, probability })) }
        ]));
        validateDecisionAnswers(answers, snapshot.questions, false);
        return { answers, provenance: { provider: 'qwen', modelId, endpoint, protocol: 'qwen.systemone' }, usage: result.usage, requestId: result.requestId, latencyMs: result.latencyMs };
      });
    }
  });
}
