import { ValidationError } from './errors.js';

/** Portable decision contract, independent of LanguageModel and chat routing. */
export type DecisionImageDetail = 'low' | 'high' | 'auto' | 'original';
export interface DecisionPromptCacheBreakpoint { mode: 'explicit' }
export interface DecisionPromptCacheOptions { mode?: 'implicit' | 'explicit'; ttl?: '30m' }
export type DecisionTextPart = { type: 'text'; text: string; promptCacheBreakpoint?: DecisionPromptCacheBreakpoint };
export type DecisionImagePart =
  | { type: 'image'; dataURL: string; detail?: DecisionImageDetail; promptCacheBreakpoint?: DecisionPromptCacheBreakpoint }
  | { type: 'image'; url: string; detail?: DecisionImageDetail; promptCacheBreakpoint?: DecisionPromptCacheBreakpoint };
export type DecisionJsonPart = { type: 'json'; data: Record<string, unknown> | readonly Record<string, unknown>[] };
export type DecisionContentPart = DecisionTextPart | DecisionImagePart | DecisionJsonPart;
export type DecisionQuestionPart =
  | { type: 'text'; text: string }
  | { type: 'image'; dataURL: string; detail?: DecisionImageDetail }
  | { type: 'image'; url: string; detail?: DecisionImageDetail }
  | { type: 'json'; data: Record<string, unknown> | readonly Record<string, unknown>[] };
export type DecisionQuestionInstructions = string | readonly DecisionQuestionPart[];
export type DecisionScoreLevel = string | { label: string; description?: string };
export type DecisionToolStatus = 'in_progress' | 'completed' | 'incomplete';
export type DecisionInputMessage =
  | { role: 'user'; content: string | readonly DecisionContentPart[]; type?: 'message' }
  | { role: 'developer' | 'system'; content: string | readonly DecisionTextPart[]; type?: 'message' }
  | { role: 'assistant'; content: string | readonly ({ type: 'text'; text: string } | { type: 'refusal'; refusal: string })[]; phase?: 'commentary' | 'final_answer'; type?: 'message' }
  | { type: 'function_call'; name: string; arguments: string; callId: string; id?: string; namespace?: string; status?: DecisionToolStatus }
  | { type: 'function_call_output'; callId: string; output: string | readonly (DecisionTextPart | DecisionImagePart)[]; id?: string; status?: DecisionToolStatus }
  | { type: 'custom_tool_call'; name: string; input: string; callId: string; id?: string; namespace?: string; status?: DecisionToolStatus }
  | { type: 'custom_tool_call_output'; callId: string; output: string | readonly (DecisionTextPart | DecisionImagePart)[]; id?: string; status?: DecisionToolStatus };
export type DecisionQuestion =
  | { type: 'predicate'; instructions: DecisionQuestionInstructions }
  | { type: 'choice'; instructions: DecisionQuestionInstructions; choices: readonly { value: string | boolean; description?: string }[] }
  | { type: 'score'; instructions: DecisionQuestionInstructions; levels: readonly DecisionScoreLevel[] };
export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>;
export type DecisionEvidence = string | readonly DecisionContentPart[] | readonly DecisionInputMessage[];
export interface DecisionInput {
  input: DecisionEvidence;
  questions: DecisionQuestions;
  abortSignal?: AbortSignal;
  /** One deadline for the complete operation; defaults to 30 seconds. */
  timeoutMs?: number;
  /** Maps to `prompt_cache_key`. */
  promptCacheKey?: string;
  /** Maps to `prompt_cache_options`. Decisions publishes `ttl: "30m"` only. */
  promptCacheOptions?: DecisionPromptCacheOptions;
  /** Maps to `safety_identifier`. Opaque end-user id, at most 64 characters. */
  safetyIdentifier?: string;
}
export interface DecisionCapabilities {
  readonly questionTypes: readonly DecisionQuestion['type'][];
  readonly inputTypes: readonly ('text' | 'image')[];
  readonly choiceValueTypes: readonly ('string' | 'boolean')[];
  readonly perQuestionRefusal: boolean;
  readonly textParts: boolean;
  readonly httpImageURLs?: boolean;
  readonly jsonInput?: boolean;
  readonly messageInput?: boolean;
  readonly questionContent?: boolean;
  readonly promptCache?: boolean;
  readonly safetyIdentifier?: boolean;
  readonly scoreDescriptions?: boolean;
  readonly optionalChoiceDescriptions?: boolean;
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
  const payload: Record<string, unknown> = { input: input.input, questions: input.questions };
  if (input.promptCacheKey !== undefined) payload.promptCacheKey = input.promptCacheKey;
  if (input.promptCacheOptions !== undefined) payload.promptCacheOptions = input.promptCacheOptions;
  if (input.safetyIdentifier !== undefined) payload.safetyIdentifier = input.safetyIdentifier;
  let json: string;
  try {
    json = JSON.stringify(payload, (_k, v: unknown) => {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' || typeof v === 'number' && !Number.isFinite(v)) invalidDecision();
      return v;
    });
  } catch { return invalidDecision(); }
  if (new TextEncoder().encode(json).byteLength > 1024 * 1024) invalidDecision();
  return { ...JSON.parse(json), abortSignal: input.abortSignal, timeoutMs: input.timeoutMs };
}
const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const levelLabel = (level: DecisionScoreLevel) => typeof level === 'string' ? level : level.label;
const httpImageURL = (value: string) => {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
};
const plainText = (value: unknown, max = 1024 * 1024): value is string => decisionText(value) && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
function validateJsonData(data: unknown): void {
  if (Array.isArray(data) ? data.some(item => !decisionRecord(item)) : !decisionRecord(data)) invalidDecision();
  let compact: string;
  try { compact = JSON.stringify(data); } catch { return invalidDecision(); }
  if (new TextEncoder().encode(compact).byteLength > 256 * 1024) invalidDecision();
  let values = 0;
  const walk = (value: unknown, depth: number): void => {
    values += 1;
    if (values > 10000) invalidDecision();
    if (Array.isArray(value) || decisionRecord(value)) {
      if (depth > 32) invalidDecision();
      for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child, depth + 1);
    } else if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number') invalidDecision();
  };
  walk(data, 1);
}
function validateImage(part: Record<string, unknown>, capabilities: DecisionCapabilities, budget: { images: number; breakpoints: number }, breakpoint: boolean): void {
  const dataURL = typeof part.dataURL === 'string';
  const url = typeof part.url === 'string';
  if (dataURL === url) invalidDecision();
  if (url && !capabilities.httpImageURLs) invalidDecision();
  if (dataURL && (!DATA_URL.test(part.dataURL as string) || (part.dataURL as string).endsWith(','))) invalidDecision();
  if (url && !httpImageURL(part.url as string)) invalidDecision();
  if (part.detail !== undefined && !['low', 'high', 'auto', 'original'].includes(part.detail as string)) invalidDecision();
  if (!keys(part, ['type', dataURL ? 'dataURL' : 'url', 'detail', ...(breakpoint ? ['promptCacheBreakpoint'] : [])])) invalidDecision();
  if (part.promptCacheBreakpoint !== undefined) {
    if (!breakpoint || !capabilities.promptCache || !decisionRecord(part.promptCacheBreakpoint) || !keys(part.promptCacheBreakpoint, ['mode']) || part.promptCacheBreakpoint.mode !== 'explicit') invalidDecision();
    budget.breakpoints += 1;
    if (budget.breakpoints > 4) invalidDecision();
  }
  budget.images += 1;
  if (budget.images > 128) invalidDecision();
}
const validateTextPart = (part: Record<string, unknown>, breakpoint: boolean, capabilities: DecisionCapabilities, budget: { images: number; breakpoints: number }) => {
  if (!keys(part, ['type', 'text', ...(breakpoint ? ['promptCacheBreakpoint'] : [])]) || !decisionText(part.text)) invalidDecision();
  if (part.promptCacheBreakpoint !== undefined) {
    if (!breakpoint || !capabilities.promptCache || !decisionRecord(part.promptCacheBreakpoint) || !keys(part.promptCacheBreakpoint, ['mode']) || part.promptCacheBreakpoint.mode !== 'explicit') invalidDecision();
    budget.breakpoints += 1;
    if (budget.breakpoints > 4) invalidDecision();
  }
};
function validateQuestionPart(part: unknown, capabilities: DecisionCapabilities, budget: { images: number; breakpoints: number }): void {
  if (!decisionRecord(part)) invalidDecision();
  if (part.type === 'text') validateTextPart(part, false, capabilities, budget);
  else if (part.type === 'image') { if (!capabilities.questionContent || !capabilities.inputTypes.includes('image')) invalidDecision(); validateImage(part, capabilities, budget, false); }
  else if (part.type === 'json') { if (!capabilities.questionContent || !capabilities.jsonInput) invalidDecision(); if (!keys(part, ['type', 'data'])) invalidDecision(); validateJsonData(part.data); }
  else invalidDecision();
}
function validateInstructions(value: unknown, capabilities: DecisionCapabilities, budget: { images: number; breakpoints: number }): void {
  if (typeof value === 'string') { if (!decisionText(value)) invalidDecision(); return; }
  if (!capabilities.questionContent || !Array.isArray(value) || !value.length) invalidDecision();
  for (const part of value) validateQuestionPart(part, capabilities, budget);
}
function validateContentPart(part: unknown, capabilities: DecisionCapabilities, budget: { images: number; breakpoints: number }): void {
  if (!decisionRecord(part) || !capabilities.textParts) invalidDecision();
  if (part.type === 'text') { if (!capabilities.inputTypes.includes('text')) invalidDecision(); validateTextPart(part, true, capabilities, budget); }
  else if (part.type === 'image') { if (!capabilities.inputTypes.includes('image')) invalidDecision(); validateImage(part, capabilities, budget, true); }
  else if (part.type === 'json') { if (!capabilities.jsonInput) invalidDecision(); if (!keys(part, ['type', 'data'])) invalidDecision(); validateJsonData(part.data); }
  else invalidDecision();
}
const toolStatus = (value: unknown) => value === undefined || value === 'in_progress' || value === 'completed' || value === 'incomplete';
function validateToolOutput(output: unknown, capabilities: DecisionCapabilities, budget: { images: number; breakpoints: number }): void {
  if (typeof output === 'string') { if (!decisionText(output)) invalidDecision(); return; }
  if (!Array.isArray(output) || !output.length) invalidDecision();
  for (const part of output) {
    if (!decisionRecord(part)) invalidDecision();
    if (part.type === 'text') validateTextPart(part, true, capabilities, budget);
    else if (part.type === 'image') validateImage(part, capabilities, budget, true);
    else invalidDecision();
  }
}
function validateMessages(input: readonly unknown[], capabilities: DecisionCapabilities, budget: { images: number; breakpoints: number }): void {
  if (!capabilities.messageInput) invalidDecision();
  const calls = new Set<string>();
  for (const item of input) {
    if (!decisionRecord(item)) invalidDecision();
    if (item.role === 'user' || item.role === 'developer' || item.role === 'system' || item.role === 'assistant') {
      if (item.type !== undefined && item.type !== 'message') invalidDecision();
      const textOnly = item.role !== 'user';
      if (typeof item.content === 'string') { if (!decisionText(item.content) || !keys(item, ['role', 'content', 'type', ...(item.role === 'assistant' ? ['phase'] : [])])) invalidDecision(); }
      else if (!Array.isArray(item.content) || !item.content.length || !keys(item, ['role', 'content', 'type', ...(item.role === 'assistant' ? ['phase'] : [])])) invalidDecision();
      else if (item.role === 'assistant') {
        for (const part of item.content) {
          if (!decisionRecord(part)) invalidDecision();
          if (part.type === 'text') { if (!keys(part, ['type', 'text']) || !decisionText(part.text)) invalidDecision(); }
          else if (part.type === 'refusal') { if (!keys(part, ['type', 'refusal']) || !decisionText(part.refusal)) invalidDecision(); }
          else invalidDecision();
        }
      } else if (textOnly) for (const part of item.content) validateTextPart(part as Record<string, unknown>, true, capabilities, budget);
      else for (const part of item.content) validateContentPart(part, capabilities, budget);
      if (item.role === 'assistant' && item.phase !== undefined && item.phase !== 'commentary' && item.phase !== 'final_answer') invalidDecision();
      continue;
    }
    const id = item.callId;
    if (!decisionText(id) || !toolStatus(item.status) || item.id !== undefined && !decisionText(item.id) || item.namespace !== undefined && !decisionText(item.namespace)) invalidDecision();
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const payload = item.type === 'function_call' ? item.arguments : item.input;
      if (!decisionText(item.name) || typeof payload !== 'string' || !keys(item, ['type', 'name', item.type === 'function_call' ? 'arguments' : 'input', 'callId', 'id', 'namespace', 'status'])) invalidDecision();
      if (calls.has(`${item.type}:${id}`)) invalidDecision();
      calls.add(`${item.type}:${id}`);
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      if (!keys(item, ['type', 'callId', 'output', 'id', 'status'])) invalidDecision();
      const call = item.type === 'function_call_output' ? `function_call:${id}` : `custom_tool_call:${id}`;
      if (!calls.has(call)) invalidDecision();
      calls.delete(call);
      validateToolOutput(item.output, capabilities, budget);
    } else invalidDecision();
  }
}
export function validateDecision(input: DecisionInput, capabilities: DecisionCapabilities): void {
  const allowed = ['input', 'questions', 'abortSignal', 'timeoutMs'];
  if (capabilities.promptCache) allowed.push('promptCacheKey', 'promptCacheOptions');
  if (capabilities.safetyIdentifier) allowed.push('safetyIdentifier');
  if (!decisionRecord(input) || !keys(input as unknown as Record<string, unknown>, allowed)) invalidDecision();
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 86400000)) invalidDecision();
  if (input.promptCacheKey !== undefined && !plainText(input.promptCacheKey)) invalidDecision();
  if (input.promptCacheOptions !== undefined) {
    if (!decisionRecord(input.promptCacheOptions) || !keys(input.promptCacheOptions, ['mode', 'ttl']) || input.promptCacheOptions.mode === undefined && input.promptCacheOptions.ttl === undefined) invalidDecision();
    if (input.promptCacheOptions.mode !== undefined && input.promptCacheOptions.mode !== 'implicit' && input.promptCacheOptions.mode !== 'explicit') invalidDecision();
    if (input.promptCacheOptions.ttl !== undefined && input.promptCacheOptions.ttl !== '30m') invalidDecision();
  }
  if (input.safetyIdentifier !== undefined && (!plainText(input.safetyIdentifier, 64))) invalidDecision();
  const budget = { images: 0, breakpoints: 0 };
  if (typeof input.input === 'string') { if (!decisionText(input.input) || !capabilities.inputTypes.includes('text')) invalidDecision(); }
  else if (!Array.isArray(input.input) || !input.input.length) invalidDecision();
  else if (decisionRecord(input.input[0]) && (typeof input.input[0].role === 'string' || input.input[0].type === 'function_call' || input.input[0].type === 'function_call_output' || input.input[0].type === 'custom_tool_call' || input.input[0].type === 'custom_tool_call_output')) validateMessages(input.input, capabilities, budget);
  else for (const part of input.input) validateContentPart(part, capabilities, budget);
  if (!decisionRecord(input.questions) || !Object.keys(input.questions).length) invalidDecision();
  for (const [id, q] of Object.entries(input.questions)) {
    if (!decisionText(id) || !decisionRecord(q) || !capabilities.questionTypes.includes(q.type)) invalidDecision();
    validateInstructions(q.instructions, capabilities, budget);
    if (q.type === 'predicate') { if (!keys(q, ['type', 'instructions'])) invalidDecision(); }
    else if (q.type === 'choice') {
      if (!keys(q, ['type', 'instructions', 'choices']) || !Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 255) invalidDecision();
      const seen = new Set<string | boolean>();
      for (const c of q.choices) {
        if (!decisionRecord(c) || !keys(c, ['value', 'description']) || !capabilities.choiceValueTypes.includes(typeof c.value as 'string' | 'boolean') || typeof c.value === 'string' && !decisionText(c.value) || seen.has(c.value as string | boolean)) invalidDecision();
        if (c.description === undefined ? !capabilities.optionalChoiceDescriptions : !decisionText(c.description)) invalidDecision();
        seen.add(c.value as string | boolean);
      }
    } else if (q.type === 'score') {
      if (!keys(q, ['type', 'instructions', 'levels']) || !Array.isArray(q.levels) || q.levels.length < 2) invalidDecision();
      const labels: string[] = [];
      for (const level of q.levels) {
        if (typeof level === 'string') { if (!decisionText(level)) invalidDecision(); labels.push(level); }
        else if (!capabilities.scoreDescriptions || !decisionRecord(level) || !keys(level, ['label', 'description']) || !decisionText(level.label) || level.description !== undefined && !decisionText(level.description)) invalidDecision();
        else labels.push(level.label);
      }
      if (new Set(labels).size !== labels.length) invalidDecision();
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
      if (q.type === 'score' && p.label !== levelLabel(q.levels[p.value as number]!)) invalidDecision();
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
