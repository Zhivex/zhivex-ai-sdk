import { ValidationError } from './errors.js';

/** Experimental, independent of LanguageModel and chat routing. */
export type DecisionQuestion =
  | { type: 'predicate'; instructions: string }
  | { type: 'choice'; instructions: string; choices: readonly { value: string | boolean; description: string }[] }
  | { type: 'score'; instructions: string; levels: readonly string[] };
export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>;
export type DecisionEvidence = string | readonly { type: 'text'; text: string }[] | readonly ({ type: 'text'; text: string } | { type: 'image'; dataURL: string })[];
export interface DecisionInput {
  input: DecisionEvidence;
  questions: DecisionQuestions;
  abortSignal?: AbortSignal;
  /** One deadline for the complete operation; defaults to 30 seconds. */
  timeoutMs?: number;
}
export interface DecisionCapabilities {
  readonly questionTypes: readonly DecisionQuestion['type'][];
  readonly inputTypes: readonly ('text' | 'image')[];
  readonly choiceValueTypes: readonly ('string' | 'boolean')[];
  readonly perQuestionRefusal: boolean;
  readonly textParts: boolean;
}
export type DecisionAnswer =
  | { type: 'refusal' }
  | { type: 'predicate'; probability: number }
  | { type: 'choice'; choice: string | boolean; probabilities: { value: string | boolean; probability: number }[]; providerConfidence?: number }
  | { type: 'score'; score: number; probabilities: { value: number; label: string; probability: number }[]; providerConfidence?: number };
export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  provenance: { provider: string; modelId: string; endpoint: string; protocol: string };
  usage: { inputTokens: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number };
  requestId?: string;
  latencyMs?: number;
}
export interface DecisionModel {
  readonly provider: string;
  readonly modelId: string;
  readonly endpoint: string;
  readonly capabilities: DecisionCapabilities;
  /** Validate all provider constraints locally without sending evidence. */
  validate(input: DecisionInput): void;
  /** Exactly one network attempt. Retry/fallback must be explicitly orchestrated. */
  decide(input: DecisionInput): Promise<DecisionResult>;
}
export const decisionRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const decisionText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
export const decisionProbability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
export function invalidDecision(): never { throw new ValidationError('Invalid experimental decision request or response.'); }
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
/** Strict JSON snapshot prevents mutation during I/O and bounds request memory. */
export function snapshotDecision(input: DecisionInput): DecisionInput {
  let json: string;
  try {
    json = JSON.stringify({ input: input.input, questions: input.questions }, (_k, v: unknown) => {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' || typeof v === 'number' && !Number.isFinite(v)) invalidDecision();
      return v;
    });
  } catch { return invalidDecision(); }
  if (new TextEncoder().encode(json).byteLength > 1024 * 1024) invalidDecision();
  return { ...JSON.parse(json), abortSignal: input.abortSignal, timeoutMs: input.timeoutMs };
}
export function validateDecision(input: DecisionInput, capabilities: DecisionCapabilities): void {
  if (!decisionRecord(input) || !keys(input as unknown as Record<string, unknown>, ['input', 'questions', 'abortSignal', 'timeoutMs'])) invalidDecision();
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 86400000)) invalidDecision();
  if (typeof input.input === 'string') { if (!decisionText(input.input) || !capabilities.inputTypes.includes('text')) invalidDecision(); }
  else {
    if (!Array.isArray(input.input) || !input.input.length || !capabilities.textParts) invalidDecision();
    for (const p of input.input) {
      if (!decisionRecord(p) || !capabilities.inputTypes.includes(p.type as 'text' | 'image')) invalidDecision();
      if (p.type === 'text') { if (!keys(p, ['type', 'text']) || !decisionText(p.text)) invalidDecision(); }
      else if (p.type === 'image') {
        if (!keys(p, ['type', 'dataURL']) || typeof p.dataURL !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.dataURL) || p.dataURL.endsWith(',')) invalidDecision();
      } else invalidDecision();
    }
  }
  if (!decisionRecord(input.questions) || !Object.keys(input.questions).length) invalidDecision();
  for (const [id, q] of Object.entries(input.questions)) {
    if (!decisionText(id) || !decisionRecord(q) || !decisionText(q.instructions) || !capabilities.questionTypes.includes(q.type)) invalidDecision();
    if (q.type === 'predicate') { if (!keys(q, ['type', 'instructions'])) invalidDecision(); }
    else if (q.type === 'choice') {
      if (!keys(q, ['type', 'instructions', 'choices']) || !Array.isArray(q.choices) || q.choices.length < 2) invalidDecision();
      const seen = new Set<string | boolean>();
      for (const c of q.choices) {
        if (!decisionRecord(c) || !keys(c, ['value', 'description']) || !capabilities.choiceValueTypes.includes(typeof c.value as 'string' | 'boolean') || typeof c.value === 'string' && !decisionText(c.value) || !decisionText(c.description) || seen.has(c.value as string | boolean)) invalidDecision();
        seen.add(c.value as string | boolean);
      }
    } else if (q.type === 'score') {
      if (!keys(q, ['type', 'instructions', 'levels']) || !Array.isArray(q.levels) || q.levels.length < 2 || !q.levels.every(decisionText) || new Set(q.levels).size !== q.levels.length) invalidDecision();
    } else invalidDecision();
  }
  snapshotDecision(input);
}
export function validateDecisionAnswers(answers: unknown, questions: DecisionQuestions, refusal: boolean): asserts answers is Record<string, DecisionAnswer> {
  if (!decisionRecord(answers) || Object.keys(answers).length !== Object.keys(questions).length) invalidDecision();
  for (const [id, q] of Object.entries(questions)) {
    if (!Object.hasOwn(answers, id)) invalidDecision();
    const a = answers[id];
    if (!decisionRecord(a)) invalidDecision();
    if (a.type === 'refusal') { if (!refusal || !keys(a, ['type'])) invalidDecision(); continue; }
    if (a.type !== q.type) invalidDecision();
    if (q.type === 'predicate') { if (!decisionProbability(a.probability)) invalidDecision(); continue; }
    if (a.providerConfidence !== undefined && !decisionProbability(a.providerConfidence)) invalidDecision();
    if (!Array.isArray(a.probabilities)) invalidDecision();
    const expected = q.type === 'choice' ? q.choices.map(c => c.value) : q.levels.map((_, i) => i);
    if (a.probabilities.length !== expected.length) invalidDecision();
    const seen = new Set<unknown>(); let sum = 0;
    for (const p of a.probabilities) {
      if (!decisionRecord(p) || !expected.some(v => v === p.value) || seen.has(p.value) || !decisionProbability(p.probability)) invalidDecision();
      if (q.type === 'score' && p.label !== q.levels[p.value as number]) invalidDecision();
      seen.add(p.value); sum += p.probability;
    }
    if (Math.abs(sum - 1) > 0.01) invalidDecision();
    if (q.type === 'choice') { if (!expected.some(v => v === a.choice)) invalidDecision(); }
    else if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > expected.length - 1) invalidDecision();
  }
}
export function decisionTokenCount(v: unknown): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0) invalidDecision();
  return v as number;
}
