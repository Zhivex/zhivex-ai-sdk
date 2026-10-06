import { experimentalDecisionHelpers,
  ConfigurationError, ProviderHTTPError, assertTrustedEndpoint, readJsonWithLimit,
  type DecisionModel, type DecisionInput, type DecisionAnswer, type DecisionCapabilities
} from '@zhivex-ai/core/provider';
const decisionRecord: typeof experimentalDecisionHelpers.decisionRecord = experimentalDecisionHelpers.decisionRecord;
const decisionProbability: typeof experimentalDecisionHelpers.decisionProbability = experimentalDecisionHelpers.decisionProbability;
const decisionTokenCount: typeof experimentalDecisionHelpers.decisionTokenCount = experimentalDecisionHelpers.decisionTokenCount;
const invalidDecision: typeof experimentalDecisionHelpers.invalidDecision = experimentalDecisionHelpers.invalidDecision;
const snapshotDecision: typeof experimentalDecisionHelpers.snapshotDecision = experimentalDecisionHelpers.snapshotDecision;
const validateDecision: typeof experimentalDecisionHelpers.validateDecision = experimentalDecisionHelpers.validateDecision;
const validateDecisionAnswers: typeof experimentalDecisionHelpers.validateDecisionAnswers = experimentalDecisionHelpers.validateDecisionAnswers;
const decisionOperation: typeof experimentalDecisionHelpers.decisionOperation = experimentalDecisionHelpers.decisionOperation;

const capabilities: DecisionCapabilities = Object.freeze({
  questionTypes: Object.freeze(['predicate', 'choice', 'score'] as const),
  inputTypes: Object.freeze(['text', 'image'] as const),
  choiceValueTypes: Object.freeze(['string', 'boolean'] as const), perQuestionRefusal: true, textParts: true
});
export function createOpenAIDecisionModel(modelId: string, options: { apiKey: string; baseURL: string; fetch?: typeof globalThis.fetch; allowUnsafeEndpoints?: boolean }): DecisionModel {
  if (modelId !== 'gpt-6-luna') throw new ConfigurationError('OpenAI Decisions currently supports gpt-6-luna only.');
  // A linear suffix scan avoids backtracking on long slash-filled paths.
  let end = options.baseURL.length;
  while (end > 0 && options.baseURL.charCodeAt(end - 1) === 47) end--;
  const endpoint = `${options.baseURL.slice(0, end)}/decisions`;
  assertTrustedEndpoint(endpoint, { protocols: ['https:'], allowUnsafe: options.allowUnsafeEndpoints, label: 'OpenAI decision endpoint' });
  const prepare = (input: DecisionInput) => {
    validateDecision(input, capabilities);
    const snapshot = snapshotDecision(input);
    if (Array.isArray(snapshot.input) && snapshot.input.filter(part => part.type === "image").length > 128) invalidDecision();
    const questions = Object.entries(snapshot.questions).map(([name, q]) => q.type === 'score'
      ? { name, type: q.type, instructions: q.instructions, levels: q.levels.map(label => ({ label })) }
      : { name, ...q });
    const evidence = typeof snapshot.input === 'string' ? snapshot.input : [{ role: 'user', content: snapshot.input.map(p => p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: p.dataURL }) }];
    const body = JSON.stringify({ model: modelId, input: evidence, questions });
    if (new TextEncoder().encode(body).byteLength > 1024 * 1024) invalidDecision();
    return { snapshot, body, questions };
  };
  const validate = (input: DecisionInput) => { prepare(input); };
  return Object.freeze({
    provider: 'openai', modelId, endpoint, capabilities, validate,
    async decide(input: DecisionInput) {
      const { snapshot, body, questions } = prepare(input);
      return decisionOperation(snapshot, async signal => {
        const response = await (options.fetch ?? globalThis.fetch)(endpoint, { method: 'POST', redirect: 'error', signal, headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' }, body });
        if (!response.ok) { await response.body?.cancel(); throw new ProviderHTTPError('Decision request failed.', response.status); }
        const json = await readJsonWithLimit<unknown>(response, { maxBytes: 1024 * 1024, provider: 'openai', endpoint: 'decisions' });
        if (!decisionRecord(json) || json.model !== modelId || !Array.isArray(json.answers) || json.answers.length !== questions.length || !decisionRecord(json.usage)) invalidDecision();
        const answers: Record<string, DecisionAnswer> = Object.create(null);
        for (const a of json.answers) {
          if (!decisionRecord(a) || typeof a.name !== 'string' || !Object.hasOwn(snapshot.questions, a.name) || Object.hasOwn(answers, a.name)) invalidDecision();
          if (a.type === 'refusal') {
            if (Object.keys(a).some(k => !['type', 'name'].includes(k))) invalidDecision();
            answers[a.name] = { type: 'refusal' };
          } else if (a.type === 'predicate') answers[a.name] = { type: 'predicate', probability: a.probability as number };
          else if (a.type === 'choice' || a.type === 'score') {
            if (!decisionProbability(a.confidence)) invalidDecision();
            answers[a.name] = (a.type === 'choice'
              ? { type: 'choice', choice: a.choice, probabilities: a.probabilities, providerConfidence: a.confidence }
              : { type: 'score', score: a.score, probabilities: a.probabilities, providerConfidence: a.confidence }) as DecisionAnswer;
          } else invalidDecision();
        }
        validateDecisionAnswers(answers, snapshot.questions, true);
        for (const a of Object.values(answers)) {
          if (a.type === 'choice') a.probabilities = a.probabilities.map(p => ({ value: p.value, probability: p.probability }));
          if (a.type === 'score') {
            a.probabilities = a.probabilities.map(p => ({ value: p.value, label: p.label, probability: p.probability }));
            const weighted = a.probabilities.reduce((sum, p) => sum + p.value * p.probability, 0);
            if (Math.abs(a.score - weighted) > 0.01 * a.probabilities.length) invalidDecision();
          }
        }
        const u = json.usage;
        if (!decisionRecord(u.input_tokens_details) || !decisionRecord(u.output_tokens_details)) invalidDecision();
        const usage = {
          inputTokens: decisionTokenCount(u.input_tokens), outputTokens: decisionTokenCount(u.output_tokens), totalTokens: decisionTokenCount(u.total_tokens),
          cachedInputTokens: decisionTokenCount(u.input_tokens_details.cached_tokens), cacheWriteTokens: decisionTokenCount(u.input_tokens_details.cache_write_tokens), reasoningTokens: decisionTokenCount(u.output_tokens_details.reasoning_tokens)
        };
        if (usage.totalTokens !== usage.inputTokens + usage.outputTokens || usage.cachedInputTokens + usage.cacheWriteTokens > usage.inputTokens || usage.reasoningTokens > usage.outputTokens) invalidDecision();
        return { answers, provenance: { provider: 'openai', modelId, endpoint, protocol: 'openai.decisions' }, usage };
      });
    }
  });
}
