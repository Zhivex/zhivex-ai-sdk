import { experimentalDecisionHelpers,
  ConfigurationError, ProviderHTTPError, assertTrustedEndpoint, readJsonWithLimit,
  type DecisionModel, type DecisionInput, type DecisionAnswer, type DecisionCapabilities,
  type DecisionContentPart, type DecisionQuestionPart, type DecisionInputMessage, type DecisionScoreLevel, type DecisionQuestion
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
  choiceValueTypes: Object.freeze(['string', 'boolean'] as const), perQuestionRefusal: true, textParts: true,
  httpImageURLs: true, jsonInput: true, messageInput: true, questionContent: true,
  promptCache: true, safetyIdentifier: true, scoreDescriptions: true, optionalChoiceDescriptions: true
});
const imageURL = (part: { dataURL?: string; url?: string }) => part.dataURL ?? part.url;
const breakpoint = (part: { promptCacheBreakpoint?: { mode: 'explicit' } }) => part.promptCacheBreakpoint ? { prompt_cache_breakpoint: { mode: 'explicit' as const } } : {};
const mapContentPart = (part: DecisionContentPart) => part.type === 'text'
  ? { type: 'input_text', text: part.text, ...breakpoint(part) }
  : part.type === 'image'
    ? { type: 'input_image', image_url: imageURL(part), ...(part.detail ? { detail: part.detail } : {}), ...breakpoint(part) }
    : { type: 'input_json', data: part.data };
const mapQuestionPart = (part: DecisionQuestionPart) => part.type === 'text'
  ? { type: 'input_text', text: part.text }
  : part.type === 'image'
    ? { type: 'input_image', image_url: imageURL(part), ...(part.detail ? { detail: part.detail } : {}) }
    : { type: 'input_json', data: part.data };
const mapInstructions = (instructions: DecisionQuestion['instructions']) => typeof instructions === 'string' ? instructions : instructions.map(mapQuestionPart);
const mapLevel = (level: DecisionScoreLevel) => typeof level === 'string' ? { label: level } : level.description ? { label: level.label, description: level.description } : { label: level.label };
const mapToolOutput = (output: string | readonly (Extract<DecisionContentPart, { type: 'text' | 'image' }>)[]) => typeof output === 'string' ? output : output.map(part => part.type === 'text'
  ? { type: 'input_text', text: part.text, ...breakpoint(part) }
  : { type: 'input_image', image_url: imageURL(part), ...(part.detail ? { detail: part.detail } : {}), ...breakpoint(part) });
const mapMessage = (item: DecisionInputMessage) => {
  if ('role' in item && item.role === 'user') return { role: 'user', ...(item.type ? { type: item.type } : {}), content: typeof item.content === 'string' ? item.content : item.content.map(mapContentPart) };
  if ('role' in item && item.role === 'assistant') return {
    role: 'assistant', ...(item.type ? { type: item.type } : {}), ...(item.phase ? { phase: item.phase } : {}),
    content: typeof item.content === 'string' ? item.content : item.content.map(part => part.type === 'text' ? { type: 'output_text', text: part.text } : { type: 'refusal', refusal: part.refusal })
  };
  if ('role' in item) return { role: item.role, ...(item.type ? { type: item.type } : {}), content: typeof item.content === 'string' ? item.content : item.content.map(part => ({ type: 'input_text', text: part.text, ...breakpoint(part) })) };
  if (item.type === 'function_call' || item.type === 'custom_tool_call') {
    const payload = item.type === 'function_call' ? { arguments: item.arguments } : { input: item.input };
    return { type: item.type, call_id: item.callId, name: item.name, ...payload, ...(item.id ? { id: item.id } : {}), ...(item.namespace ? { namespace: item.namespace } : {}), ...(item.status ? { status: item.status } : {}) };
  }
  return { type: item.type, call_id: item.callId, output: mapToolOutput(item.output), ...(item.id ? { id: item.id } : {}), ...(item.status ? { status: item.status } : {}) };
};
const isMessage = (value: unknown): value is DecisionInputMessage => !!value && typeof value === 'object' && ('role' in value || 'type' in value && value.type !== 'text' && value.type !== 'image' && value.type !== 'json');
/** The request model stays `gpt-6-luna`. A GA response may echo that id or a dated snapshot of it. */
const matchesDecisionModel = (actual: unknown, requested: string) => typeof actual === 'string' && (actual === requested || actual.startsWith(`${requested}-`) && /^\d{4}-\d{2}-\d{2}$/.test(actual.slice(requested.length + 1)));
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
    const questions = Object.entries(snapshot.questions).map(([name, q]) => q.type === 'score'
      ? { name, type: q.type, instructions: mapInstructions(q.instructions), levels: q.levels.map(mapLevel) }
      : q.type === 'choice'
        ? { name, type: q.type, instructions: mapInstructions(q.instructions), choices: q.choices.map(choice => choice.description === undefined ? { value: choice.value } : { value: choice.value, description: choice.description }) }
        : { name, type: q.type, instructions: mapInstructions(q.instructions) });
    const evidence = typeof snapshot.input === 'string' ? snapshot.input : isMessage(snapshot.input[0]) ? (snapshot.input as readonly DecisionInputMessage[]).map(mapMessage) : [{ role: 'user', content: (snapshot.input as readonly DecisionContentPart[]).map(mapContentPart) }];
    const request: Record<string, unknown> = { model: modelId, input: evidence, questions };
    if (snapshot.promptCacheKey !== undefined) request.prompt_cache_key = snapshot.promptCacheKey;
    if (snapshot.promptCacheOptions !== undefined) request.prompt_cache_options = snapshot.promptCacheOptions;
    if (snapshot.safetyIdentifier !== undefined) request.safety_identifier = snapshot.safetyIdentifier;
    const body = JSON.stringify(request);
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
        if (!decisionRecord(json) || !matchesDecisionModel(json.model, modelId) || !Array.isArray(json.answers) || json.answers.length !== questions.length || !decisionRecord(json.usage)) invalidDecision();
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
