import {
  experimentalDecisionHelpers, ConfigurationError, ProviderHTTPError, readJsonWithLimit,
  type DecisionAnswer, type DecisionCapabilities, type DecisionContentPart, type DecisionInput,
  type DecisionModel, type DecisionQuestion, type DecisionScoreLevel
} from '@zhivex-ai/core/provider';

const { decisionRecord, decisionProbability, decisionTokenCount, invalidDecision,
  snapshotDecision, validateDecision, decisionOperation } = experimentalDecisionHelpers;
const validateDecisionAnswers: typeof experimentalDecisionHelpers.validateDecisionAnswers = experimentalDecisionHelpers.validateDecisionAnswers;
const MIB = 1024 * 1024;
// Allows the base64 expansion of 100 MiB of media plus instructions and criteria.
const MAX_INPUT_BYTES = 140 * MIB;
const capabilities: DecisionCapabilities = Object.freeze({
  questionTypes: Object.freeze(['predicate', 'choice', 'score'] as const),
  inputTypes: Object.freeze(['text', 'image', 'audio', 'video', 'document'] as const),
  choiceValueTypes: Object.freeze(['string'] as const),
  perQuestionRefusal: false, textParts: true, httpImageURLs: true, mediaInput: true,
  questionContent: true, predicateDescriptions: true, scoreDescriptions: true,
  optionalChoiceDescriptions: true, emptyChoiceDescriptions: true, maxInputBytes: MAX_INPUT_BYTES
});
const mimeTypes: Record<string, readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/bmp', 'image/tiff'],
  audio: ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/m4a', 'audio/opus', 'audio/webm', 'audio/l16', 'audio/alaw', 'audio/mulaw'],
  video: ['video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/webm', 'video/wmv', 'video/x-flv', 'video/3gpp'],
  document: ['application/pdf']
};
const label = (level: DecisionScoreLevel) => typeof level === 'string' ? level : level.label;
const criterion = (level: DecisionScoreLevel) => typeof level === 'string' ? level : level.description ? `${level.label}: ${level.description}` : level.label;
const utf8 = new TextEncoder();
function validOption(value: string | boolean): value is string {
  return typeof value === 'string' && [...value].length <= 128 && utf8.encode(value).length <= 512 && value.length > 0
    && value === value.trim() && !/[\u0000-\u001f\u007f]|[^\S ]/u.test(value);
}
function mediaURI(uri: string): string {
  let url: URL;
  try { url = new URL(uri); } catch { return invalidDecision(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(url.hostname)) invalidDecision();
  return uri;
}
function mapContent(part: DecisionContentPart, budget: { inlineBytes: number }): Record<string, unknown> {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'json') return invalidDecision();
  // Compatibility with the existing portable inline image representation.
  if (part.type === 'image' && ('dataURL' in part || 'url' in part)) {
    if ('url' in part) throw new ConfigurationError('Gemini decision images require mimeType with uri, or an inline dataURL.');
    if (part.detail === 'original') invalidDecision();
    const comma = part.dataURL.indexOf(',');
    return mapContent({ type: 'image', mimeType: part.dataURL.slice(5, part.dataURL.indexOf(';')),
      data: part.dataURL.slice(comma + 1), ...(part.detail === 'low' || part.detail === 'high' ? { resolution: part.detail } : {}) }, budget);
  }
  if (!mimeTypes[part.type]?.includes(part.mimeType)) invalidDecision();
  const result: Record<string, unknown> = { type: part.type, mime_type: part.mimeType };
  if (part.data !== undefined) {
    const bytes = part.data.length / 4 * 3 - (part.data.endsWith('==') ? 2 : part.data.endsWith('=') ? 1 : 0);
    budget.inlineBytes += bytes;
    if (budget.inlineBytes > 100 * MIB || part.type === 'document' && bytes > 50 * MIB) invalidDecision();
    result.data = part.data;
  } else result.uri = mediaURI(part.uri);
  if ('resolution' in part && part.resolution !== undefined) result.resolution = part.resolution;
  return result;
}
function mapQuestion(q: DecisionQuestion): Record<string, unknown> {
  const instructions = typeof q.instructions === 'string' ? q.instructions : q.instructions.map(part => {
    if (part.type !== 'text') return invalidDecision();
    return { type: 'text', text: part.text };
  });
  if (q.type === 'predicate') return { type: 'noul', instructions,
    ...(q.trueDescription !== undefined || q.falseDescription !== undefined ? { criteria: {
      ...(q.trueDescription !== undefined ? { true_description: q.trueDescription } : {}),
      ...(q.falseDescription !== undefined ? { false_description: q.falseDescription } : {})
    } } : {}) };
  if (q.type === 'choice') {
    if (q.choices.some(c => !validOption(c.value))) invalidDecision();
    return { type: 'choice', instructions, criteria: Object.fromEntries(q.choices.map(c => [c.value, c.description ?? ''])) };
  }
  if (q.levels.length > 255) invalidDecision();
  return { type: 'score', instructions, criteria: q.levels.map(criterion) };
}
function distribution(value: unknown, expected: readonly string[]): Record<string, number> {
  if (!decisionRecord(value) || Object.keys(value).length !== expected.length) return invalidDecision();
  for (const key of expected) if (!Object.hasOwn(value, key) || !decisionProbability(value[key])) invalidDecision();
  return value as Record<string, number>;
}

/** Native Gemini Decisions, separate from chat and Interactions; one HTTP attempt. */
export function createGeminiDecisionModel(modelId: string, apiKey: string, baseURL: string, fetcher: typeof globalThis.fetch): DecisionModel {
  if (!/^[A-Za-z0-9_.-]+$/.test(modelId)) throw new ConfigurationError('Invalid Gemini decision model ID.');
  const endpoint = `${baseURL}/decisions`;
  const prepare = (input: DecisionInput) => {
    validateDecision(input, capabilities);
    const snapshot = snapshotDecision(input, MAX_INPUT_BYTES);
    const entries = Object.entries(snapshot.questions);
    if (entries.length > 1000 || entries.some(([key]) => !/^[A-Za-z0-9_-]{1,64}$/.test(key))) invalidDecision();
    const budget = { inlineBytes: 0 };
    const evidence = typeof snapshot.input === 'string' ? snapshot.input : snapshot.input.map(part => {
      if (!('type' in part) || !['text', 'image', 'audio', 'video', 'document'].includes(part.type ?? '')) return invalidDecision();
      return mapContent(part as DecisionContentPart, budget);
    });
    const body = JSON.stringify({ model: modelId, input: evidence,
      questions: Object.fromEntries(entries.map(([key, q]) => [key, mapQuestion(q)])) });
    if (utf8.encode(body).byteLength > MAX_INPUT_BYTES) invalidDecision();
    return { snapshot, body };
  };
  return Object.freeze({
    provider: 'gemini', modelId, endpoint, capabilities,
    validate(input: DecisionInput) { prepare(input); },
    async decide(input: DecisionInput) {
      const { snapshot, body } = prepare(input);
      return decisionOperation(snapshot, async signal => {
        const start = performance.now();
        const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', signal,
          headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' }, body });
        if (!response.ok) { await response.body?.cancel(); throw new ProviderHTTPError('Decision request failed.', response.status); }
        const json = await readJsonWithLimit<unknown>(response, { maxBytes: 32 * MIB, provider: 'gemini', endpoint: 'decisions' });
        if (!decisionRecord(json) || !decisionRecord(json.answers) || !decisionRecord(json.usage)
          || Object.keys(json.answers).length !== Object.keys(snapshot.questions).length) return invalidDecision();
        const answers: Record<string, DecisionAnswer> = Object.create(null);
        for (const [key, q] of Object.entries(snapshot.questions)) {
          const a = Object.hasOwn(json.answers, key) ? json.answers[key] : undefined;
          if (!decisionRecord(a) || !decisionProbability(a.confidence)) return invalidDecision();
          const providerConfidence = a.confidence;
          if (q.type === 'predicate') {
            if (a.type !== 'noul' || !decisionProbability(a.noul) || a.noul < 0.01 || a.noul > 0.99) invalidDecision();
            answers[key] = { type: 'predicate', probability: a.noul as number, providerConfidence };
          } else if (q.type === 'choice') {
            if (a.type !== 'choice' || typeof a.choice !== 'string') return invalidDecision();
            const probabilities = distribution(a.probabilities, q.choices.map(c => c.value as string));
            answers[key] = { type: 'choice', choice: a.choice, providerConfidence,
              probabilities: q.choices.map(c => ({ value: c.value, probability: probabilities[c.value as string]! })) };
          } else {
            if (a.type !== 'score' || typeof a.score !== 'number' || !decisionRecord(a.legend) || Object.keys(a.legend).length !== q.levels.length) return invalidDecision();
            const probabilities = distribution(a.probabilities, q.levels.map((_, i) => String(i)));
            for (const [i, level] of q.levels.entries()) if (!Object.hasOwn(a.legend, i) || a.legend[i] !== criterion(level)) invalidDecision();
            const weighted = q.levels.reduce((sum, _, i) => sum + i * probabilities[String(i)]!, 0);
            // Provider examples round probabilities; allow that rounding, not arbitrary scores.
            if (Math.abs(weighted - a.score) > 0.01 * q.levels.length) invalidDecision();
            answers[key] = { type: 'score', score: a.score, providerConfidence,
              probabilities: q.levels.map((level, i) => ({ value: i, label: label(level), probability: probabilities[String(i)]! })) };
          }
        }
        validateDecisionAnswers(answers, snapshot.questions, false);
        const usage = { inputTokens: decisionTokenCount(json.usage.total_input_tokens),
          outputTokens: decisionTokenCount(json.usage.total_output_tokens), totalTokens: decisionTokenCount(json.usage.total_tokens),
          inputTokensByModality: [] as { modality: string; tokens: number }[] };
        if (usage.outputTokens !== 0 || usage.totalTokens !== usage.inputTokens || !Array.isArray(json.usage.input_tokens_by_modality)) invalidDecision();
        const seen = new Set<string>();
        for (const item of json.usage.input_tokens_by_modality as unknown[]) {
          if (!decisionRecord(item) || typeof item.modality !== 'string' || !['text', 'image', 'audio'].includes(item.modality) || seen.has(item.modality)) return invalidDecision();
          seen.add(item.modality);
          usage.inputTokensByModality.push({ modality: item.modality, tokens: decisionTokenCount(item.tokens) });
        }
        if (usage.inputTokensByModality.reduce((sum, item) => sum + item.tokens, 0) !== usage.inputTokens) invalidDecision();
        return { answers, usage, provenance: { provider: 'gemini', modelId, endpoint, protocol: 'gemini.decisions' },
          ...(response.headers.get('x-request-id') ? { requestId: response.headers.get('x-request-id')! } : {}), latencyMs: performance.now() - start };
      });
    }
  });
}
