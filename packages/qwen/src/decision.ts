import { trimTrailingSlashes } from "./url-path.js";
import { ConfigurationError, ValidationError, ProviderHTTPError, assertTrustedEndpoint, readJsonWithLimit, withRetry, withTimeoutSignal, type JsonValue } from "@zhivex-ai/core/provider";

export interface QwenDecisionChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string> }
export interface QwenDecisionNoulQuestion { type: "noul"; instructions: string }
export interface QwenDecisionScoreQuestion { type: "score"; instructions: string; criteria: readonly string[] }
export type QwenDecisionQuestion = QwenDecisionChoiceQuestion | QwenDecisionNoulQuestion | QwenDecisionScoreQuestion;
export type QwenDecisionQuestions = Record<string, QwenDecisionQuestion>;
export interface QwenDecisionChoiceAnswer { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
export interface QwenDecisionNoulAnswer { type: "noul"; noul: number }
export interface QwenDecisionScoreAnswer { type: "score"; score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> }
export type QwenDecisionAnswer = QwenDecisionChoiceAnswer | QwenDecisionNoulAnswer | QwenDecisionScoreAnswer;
export type QwenDecisionAnswers<Q extends QwenDecisionQuestions> = { [K in keyof Q]: Q[K] extends QwenDecisionChoiceQuestion ? QwenDecisionChoiceAnswer : Q[K] extends QwenDecisionNoulQuestion ? QwenDecisionNoulAnswer : Q[K] extends QwenDecisionScoreQuestion ? QwenDecisionScoreAnswer : QwenDecisionAnswer };
export interface QwenDecisionInput<Q extends QwenDecisionQuestions = QwenDecisionQuestions> {
  state: string | Record<string, JsonValue>;
  questions: Q;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** Defaults to zero to avoid duplicate billable inference. */
  maxRetries?: number;
  retryBackoffMs?: number;
}
export interface QwenDecisionResult<Q extends QwenDecisionQuestions = QwenDecisionQuestions> {
  model: string;
  requestId: string;
  answers: QwenDecisionAnswers<Q>;
  usage: { inputTokens: number };
  latencyMs: number;
}
export interface QwenDecisionModel {
  readonly provider: "qwen";
  readonly modelId: string;
  decide<Q extends QwenDecisionQuestions>(input: QwenDecisionInput<Q>): Promise<QwenDecisionResult<Q>>;
}
export interface QwenDecisionModelOptions {
  apiKey: string;
  baseURL: string;
  fetch?: typeof globalThis.fetch;
  allowUnsafeEndpoints?: boolean;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const fail = (message: string): never => { throw new ValidationError(`Qwen decision: ${message}`); };
function sameKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function distribution(value: unknown, keys: string[]): asserts value is Record<string, number> {
  if (!record(value) || !sameKeys(value, keys) || !Object.values(value).every(probability)) fail("invalid probability distribution.");
  const sum = Object.values(value as Record<string, number>).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.01) fail("probabilities must sum to one.");
}
function validateQuestions(value: unknown): asserts value is QwenDecisionQuestions {
  if (!record(value) || !Object.keys(value).length) fail("questions must be a nonempty object.");
  for (const [id, q] of Object.entries(value as Record<string, unknown>)) {
    if (!text(id) || !record(q) || !text(q.instructions)) fail("each question requires an id and instructions.");
    const question = q as Record<string, unknown>;
    if (question.type === "choice") {
      if (!record(question.criteria) || Object.keys(question.criteria).length < 2 || !Object.entries(question.criteria).every(([k, v]) => text(k) && text(v))) fail("choice requires at least two named criteria.");
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || !question.criteria.every(text)) fail("score requires at least two ordered criteria.");
    } else if (question.type !== "noul") fail("unsupported question type.");
    if (!Object.keys(question).every(key => ["type", "instructions", ...(question.type === "noul" ? [] : ["criteria"])].includes(key))) fail("unsupported question option.");
  }
}
function parse<Q extends QwenDecisionQuestions>(value: unknown, questions: Q, model: string): QwenDecisionResult<Q> {
  if (!record(value) || value.model !== model || !text(value.request_id) || !record(value.answers) || !sameKeys(value.answers, Object.keys(questions))) fail("invalid response envelope.");
  const json = value as Record<string, unknown>;
  const answers = json.answers as Record<string, unknown>;
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!record(answer) || answer.type !== question.type) fail("answer type does not match its question.");
    const a = answer as Record<string, unknown>;
    if (question.type === "noul") {
      if (!probability(a.noul)) fail("invalid noul probability.");
    } else {
      if (!probability(a.confidence)) fail("invalid confidence.");
      const keys = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
      distribution(a.probabilities, keys);
      if (question.type === "choice") {
        if (typeof a.choice !== "string" || !keys.includes(a.choice)) fail("unknown choice.");
      } else {
        if (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < 0 || a.score > keys.length - 1) fail("score is outside its criteria range.");
        if (!record(a.legend) || !sameKeys(a.legend, keys) || !keys.every((key, i) => (a.legend as Record<string, unknown>)[key] === question.criteria[i])) fail("score legend does not match criteria.");
      }
    }
  }
  const usage = json.usage;
  if (!record(usage) || !Number.isSafeInteger(usage.input_tokens) || (usage.input_tokens as number) < 0 || typeof json.latency_ms !== "number" || !Number.isFinite(json.latency_ms) || json.latency_ms < 0) fail("invalid usage or latency.");
  return { model, requestId: json.request_id as string, answers: answers as QwenDecisionAnswers<Q>, usage: { inputTokens: (usage as Record<string, number>).input_tokens! }, latencyMs: json.latency_ms as number };
}

export function createQwenDecisionModel(modelId: string, options: QwenDecisionModelOptions): QwenDecisionModel {
  if (modelId !== "decision-model-preview") throw new ConfigurationError("Qwen decisionModel currently supports decision-model-preview only.");
  if (!text(options.apiKey)) throw new ConfigurationError("Qwen decisionModel requires an API key.");
  const endpoint = `${trimTrailingSlashes(options.baseURL)}/systemone`;
  assertTrustedEndpoint(endpoint, { protocols: ["https:"], allowUnsafe: options.allowUnsafeEndpoints, label: "Qwen decision endpoint" });
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    provider: "qwen", modelId,
    async decide(input) {
      validateQuestions(input.questions);
      if (!(text(input.state) || record(input.state))) fail("state must be a nonempty string or JSON object.");
      let body: string;
      try { body = JSON.stringify({ model: modelId, state: input.state, questions: input.questions }, (_key, value: unknown) => {
        if (typeof value === "number" && !Number.isFinite(value) || typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") fail("state and questions must be JSON serializable.");
        return value;
      }); } catch { return fail("state and questions must be JSON serializable."); }
      if (new TextEncoder().encode(body).byteLength > 1024 * 1024) fail("request exceeds 1 MiB.");
      // Snapshot validated questions so caller mutations during I/O cannot change validation.
      const questions = JSON.parse(body).questions as typeof input.questions;
      const { signal, cleanup } = withTimeoutSignal({ abortSignal: input.abortSignal, timeoutMs: input.timeoutMs ?? 30000 });
      try {
        const response = await withRetry(async () => {
          const response = await fetcher(endpoint, { method: "POST", redirect: "error", signal, headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" }, body });
          if (!response.ok) {
            await response.body?.cancel();
            // Avoid retaining server error bodies that may echo sensitive business state.
            throw new ProviderHTTPError(`Qwen decision request failed (${response.status}).`, response.status);
          }
          return response;
        }, { maxRetries: input.maxRetries ?? 0, retryBackoffMs: input.retryBackoffMs, abortSignal: signal });
        return parse(await readJsonWithLimit<unknown>(response, { maxBytes: 1024 * 1024, provider: "qwen", endpoint: "systemone" }), questions, modelId);
      } finally { cleanup(); }
    }
  };
}
