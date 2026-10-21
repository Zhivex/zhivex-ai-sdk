import { REDACTED, redactTraceValue, truncateForDisplay } from "./redact.js";
import type { RawSpan, TraceWarning } from "./spans.js";

export interface TokenUsageView {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTokensDetails?: {
    ttl30mTokens?: number;
    ttl12hTokens?: number;
  };
  reasoningTokens?: number;
}

export interface TraceStepView {
  index: number;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  toolCallCount: number;
  usage?: string;
}

export interface TraceToolCallView {
  id?: string;
  name: string;
  step?: number;
  status?: string;
  arguments: string;
  result: string;
}

export type ApprovalDecision = "approved" | "denied" | "pending";

export interface TraceApprovalView {
  id?: string;
  what: string;
  who: string;
  when?: string;
  decision: ApprovalDecision;
  reason?: string;
}

export interface TraceRunView {
  runId: string;
  agentId?: string;
  provider?: string;
  modelId?: string;
  status?: string;
  startedAt?: string;
  updatedAt?: string;
  stepCount: number;
  steps: TraceStepView[];
  stepDetail: "recorded" | "count-only" | "none";
  toolCalls: TraceToolCallView[];
  approvals: TraceApprovalView[];
  usage?: string;
  cost?: string;
}

export interface TraceView {
  runs: TraceRunView[];
  warnings: TraceWarning[];
}

const OMITTED = "omitted";
const WHO_NOT_RECORDED = "not recorded";
const WHO_FIELDS = ["approver", "approvedBy", "approved_by", "actor", "userId", "user_id", "user", "zhivex.approver"];

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

export const formatTimestamp = (value: number | undefined): string | undefined => {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const formatUsage = (usage: TokenUsageView | undefined): string | undefined => {
  if (!usage) return undefined;
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${usage.inputTokens} in`);
  if (usage.outputTokens !== undefined) parts.push(`${usage.outputTokens} out`);
  if (usage.totalTokens !== undefined) parts.push(`${usage.totalTokens} total`);
  if (usage.cachedInputTokens !== undefined) parts.push(`${usage.cachedInputTokens} cached`);
  if (usage.cacheWriteTokens !== undefined) parts.push(`${usage.cacheWriteTokens} cache write`);
  const ttl30mTokens = usage.cacheWriteTokensDetails?.ttl30mTokens;
  const ttl12hTokens = usage.cacheWriteTokensDetails?.ttl12hTokens;
  if (ttl30mTokens !== undefined || ttl12hTokens !== undefined) {
    const lifetimes = [
      ttl30mTokens !== undefined ? `${ttl30mTokens} 30m` : undefined,
      ttl12hTokens !== undefined ? `${ttl12hTokens} 12h` : undefined
    ].filter((part): part is string => part !== undefined);
    parts.push(lifetimes.join(", "));
  }
  if (usage.reasoningTokens !== undefined) parts.push(`${usage.reasoningTokens} reasoning`);
  return parts.length > 0 ? parts.join(" / ") : undefined;
};

const readUsage = (value: unknown): TokenUsageView | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const details = asRecord(record.cacheWriteTokensDetails);
  const ttl30mTokens = details ? asNumber(details.ttl30mTokens) : undefined;
  const ttl12hTokens = details ? asNumber(details.ttl12hTokens) : undefined;
  const usage: TokenUsageView = {
    inputTokens: asNumber(record.inputTokens),
    outputTokens: asNumber(record.outputTokens),
    totalTokens: asNumber(record.totalTokens),
    cachedInputTokens: asNumber(record.cachedInputTokens),
    cacheWriteTokens: asNumber(record.cacheWriteTokens),
    ...(ttl30mTokens !== undefined || ttl12hTokens !== undefined
      ? { cacheWriteTokensDetails: {
          ...(ttl30mTokens !== undefined ? { ttl30mTokens } : {}),
          ...(ttl12hTokens !== undefined ? { ttl12hTokens } : {})
        } }
      : {}),
    reasoningTokens: asNumber(record.reasoningTokens)
  };
  return Object.values(usage).some((entry) => entry !== undefined) ? usage : undefined;
};

const formatCost = (value: unknown): string | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const input = asNumber(record.inputCost);
  const output = asNumber(record.outputCost);
  const total = asNumber(record.totalCost) ?? (
    input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined
  );
  if (total === undefined) return undefined;
  // `\.?0+$` removes a trailing fraction of zeros and leaves the integer part, so `0` stays `0`.
  const rendered = total.toFixed(6).replace(/\.?0+$/, "");
  const currency = asString(record.currency);
  return currency ? `${rendered} ${currency}` : rendered;
};

const payloadText = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return OMITTED;
  return truncateForDisplay(value);
};

const attribute = (attributes: Record<string, unknown>, key: string): unknown => attributes[key];

const whoFrom = (record: Record<string, unknown> | undefined): string | undefined => {
  if (!record) return undefined;
  for (const key of WHO_FIELDS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return whoFrom(asRecord(record.metadata));
};

type Decision = ApprovalDecision;

interface ApprovalDraft {
  id?: string;
  what?: string;
  who?: string;
  whenMs?: number;
  decision?: Decision;
  reason?: string;
}

interface ToolDraft {
  id?: string;
  name?: string;
  step?: number;
  status?: string;
  arguments?: unknown;
  result?: unknown;
  argumentsSeen: boolean;
  resultSeen: boolean;
}

interface RunDraft {
  runId: string;
  agentId?: string;
  provider?: string;
  modelId?: string;
  status?: string;
  startedAtMs?: number;
  updatedAtMs?: number;
  steps: TraceStepView[];
  countedSteps?: number;
  tools: Map<string, ToolDraft>;
  approvals: Map<string, ApprovalDraft>;
  usage?: TokenUsageView;
  cost?: string;
  toolSequence: number;
  approvalSequence: number;
}

const fillString = (current: string | undefined, next: string | undefined): string | undefined => current ?? next;

const decisionFrom = (value: unknown): Decision | undefined => {
  if (value === true || value === "approved" || value === "allowed") return "approved";
  if (value === false || value === "denied") return "denied";
  return undefined;
};

const mergeDecision = (current: Decision | undefined, next: Decision | undefined): Decision | undefined => {
  if (!next) return current;
  if (!current || current === "pending") return next;
  if (next === "pending") return current;
  return next;
};

const upsertTool = (run: RunDraft, incoming: ToolDraft) => {
  const key = incoming.id ?? `anon-tool:${run.toolSequence++}`;
  const existing = run.tools.get(key);
  if (!existing) {
    run.tools.set(key, incoming);
    return;
  }
  existing.name = fillString(existing.name, incoming.name);
  existing.step = existing.step ?? incoming.step;
  existing.status = fillString(existing.status, incoming.status);
  if (!existing.argumentsSeen && incoming.argumentsSeen) {
    existing.arguments = incoming.arguments;
    existing.argumentsSeen = true;
  }
  if (!existing.resultSeen && incoming.resultSeen) {
    existing.result = incoming.result;
    existing.resultSeen = true;
  }
};

const approvalKey = (draft: ApprovalDraft, sequence: number): string => draft.id ?? `anon-approval:${sequence}`;

const upsertApproval = (run: RunDraft, incoming: ApprovalDraft) => {
  const key = approvalKey(incoming, run.approvalSequence);
  if (!incoming.id) run.approvalSequence += 1;
  const existing = run.approvals.get(key);
  if (!existing) {
    run.approvals.set(key, incoming);
    return;
  }
  existing.what = existing.what && existing.what !== existing.id ? existing.what : incoming.what ?? existing.what;
  if ((!existing.who || existing.who === WHO_NOT_RECORDED) && incoming.who) existing.who = incoming.who;
  existing.decision = mergeDecision(existing.decision, incoming.decision);
  existing.reason = fillString(existing.reason, incoming.reason);
  if (incoming.whenMs !== undefined && (existing.decision === incoming.decision || existing.whenMs === undefined)) {
    existing.whenMs = incoming.whenMs;
  }
};

const createRun = (runId: string): RunDraft => ({
  runId,
  steps: [],
  tools: new Map(),
  approvals: new Map(),
  toolSequence: 0,
  approvalSequence: 0
});

const applyUsage = (run: RunDraft, usage: TokenUsageView | undefined) => {
  if (!run.usage && usage) run.usage = usage;
};

const applyLedger = (runs: Map<string, RunDraft>, ledger: unknown) => {
  const record = asRecord(ledger);
  const runId = record ? asString(record.runId) : undefined;
  if (!record || !runId) return;
  const run = runs.get(runId) ?? createRun(runId);
  runs.set(runId, run);
  run.agentId = fillString(run.agentId, asString(record.agentId));
  run.provider = fillString(run.provider, asString(record.provider));
  run.modelId = fillString(run.modelId, asString(record.modelId));
  run.status = fillString(run.status, asString(record.status));

  const trace = asRecord(record.trace);
  const audit = asRecord(record.audit);
  const summary = asRecord(record.summary);
  const snapshot = asRecord(record.snapshot);
  run.startedAtMs = run.startedAtMs ?? asNumber(trace?.startedAt) ?? asNumber(audit?.startedAt) ?? asNumber(asRecord(summary?.latency)?.startedAt);
  run.updatedAtMs = run.updatedAtMs ?? asNumber(trace?.updatedAt) ?? asNumber(audit?.updatedAt) ?? asNumber(asRecord(summary?.latency)?.finishedAt);
  applyUsage(run, readUsage(audit?.usage) ?? readUsage(trace?.usage) ?? readUsage(summary?.usage) ?? readUsage(snapshot?.usage));
  if (!run.cost) run.cost = formatCost(record.cost) ?? formatCost(summary?.cost);

  const traceSteps = Array.isArray(trace?.steps) ? trace.steps : undefined;
  if (run.steps.length === 0 && traceSteps) {
    run.steps = traceSteps.flatMap((entry) => {
      const step = asRecord(entry);
      if (!step || asNumber(step.index) === undefined) return [];
      const startedAt = asNumber(step.startedAt);
      const finishedAt = asNumber(step.finishedAt);
      const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
      return [{
        index: asNumber(step.index) as number,
        status: asString(step.status),
        startedAt: formatTimestamp(startedAt),
        finishedAt: formatTimestamp(finishedAt),
        durationMs: asNumber(step.durationMs) ?? (
          startedAt !== undefined && finishedAt !== undefined ? Math.max(0, finishedAt - startedAt) : undefined
        ),
        toolCallCount: toolCalls.length,
        usage: formatUsage(readUsage(step.usage))
      }];
    }).sort((left, right) => left.index - right.index);
  }
  if (run.countedSteps === undefined) {
    run.countedSteps = asNumber(summary?.steps) ?? asNumber(audit?.steps) ?? asNumber(snapshot?.steps);
  }

  const absorbCall = (value: unknown, step: number | undefined, result?: unknown, status?: string) => {
    const call = asRecord(value);
    if (!call) return;
    const name = asString(call.name) ?? asString(call.toolName);
    const id = asString(call.id) ?? asString(call.toolCallId);
    if (!name && !id) return;
    const hasInput = "input" in call || "arguments" in call;
    const hasResult = result !== undefined || "output" in call || asRecord(call.error) !== undefined;
    upsertTool(run, {
      id,
      name,
      step: asNumber(call.step) ?? step,
      status: status ?? asString(call.status) ?? (asBoolean(call.isError) === true ? "failed" : undefined),
      arguments: call.input ?? call.arguments,
      result: result ?? call.output ?? asRecord(call.error)?.message,
      argumentsSeen: hasInput && (call.input ?? call.arguments) != null,
      resultSeen: hasResult && (result ?? call.output ?? asRecord(call.error)?.message) != null
    });
  };

  if (Array.isArray(record.toolAudit)) {
    for (const entry of record.toolAudit) {
      const tool = asRecord(entry);
      if (!tool) continue;
      const error = asRecord(tool.error);
      upsertTool(run, {
        id: asString(tool.toolCallId),
        name: asString(tool.toolName),
        step: asNumber(tool.step),
        status: asString(tool.status),
        arguments: tool.input,
        result: tool.output ?? error?.message,
        argumentsSeen: tool.input != null,
        resultSeen: tool.output != null || error?.message != null
      });
    }
  }

  for (const entry of traceSteps ?? []) {
    const step = asRecord(entry);
    if (!step) continue;
    const index = asNumber(step.index);
    for (const call of Array.isArray(step.toolCalls) ? step.toolCalls : []) absorbCall(call, index);
    for (const resultEntry of Array.isArray(step.toolResults) ? step.toolResults : []) {
      const result = asRecord(resultEntry);
      if (!result) continue;
      upsertTool(run, {
        id: asString(result.toolCallId),
        name: asString(result.toolName),
        step: index,
        status: asBoolean(result.isError) === true ? "failed" : undefined,
        arguments: undefined,
        result: result.output ?? asRecord(result.error)?.message,
        argumentsSeen: false,
        resultSeen: result.output != null || asRecord(result.error)?.message != null
      });
    }
  }

  for (const entry of Array.isArray(record.timeline) ? record.timeline : []) {
    const event = asRecord(entry);
    if (!event) continue;
    if (event.type === "tool-call") absorbCall(event.toolCall, asNumber(event.step));
    if (event.type === "tool-result") {
      const result = asRecord(event.result);
      if (!result) continue;
      upsertTool(run, {
        id: asString(result.toolCallId),
        name: asString(result.toolName),
        step: asNumber(event.step),
        status: asBoolean(result.isError) === true ? "failed" : "completed",
        result: result.output ?? asRecord(result.error)?.message,
        argumentsSeen: false,
        resultSeen: result.output != null || asRecord(result.error)?.message != null
      });
    }
    if (event.type === "approval-request") observeApproval(run, asRecord(event.approval), undefined, "pending");
  }

  for (const entry of Array.isArray(trace?.events) ? trace.events : []) observeTraceEvent(run, entry);
  for (const entry of Array.isArray(trace?.approvals) ? trace.approvals : []) {
    observeApproval(run, asRecord(entry), undefined, "pending");
  }
  for (const entry of Array.isArray(snapshot?.pendingApprovals) ? snapshot.pendingApprovals : []) {
    observeApproval(run, asRecord(entry), undefined, "pending");
  }
};

const observeApproval = (
  run: RunDraft,
  record: Record<string, unknown> | undefined,
  whenMs: number | undefined,
  fallback: Decision | undefined
) => {
  if (!record && fallback === undefined) return;
  const metadata = asRecord(record?.metadata);
  const toolCall = asRecord(record?.toolCall);
  const approved = decisionFrom(record?.approved ?? record?.approve ?? record?.["zhivex.approved"]);
  const decision = approved === "denied" && metadata?.approvalRequired === true ? "pending" : approved ?? fallback;
  const id = asString(record?.id)
    ?? asString(record?.approvalRequestId)
    ?? asString(record?.requestId)
    ?? asString(record?.["zhivex.approval_id"])
    ?? asString(toolCall?.id)
    ?? asString(record?.["zhivex.tool_call_id"])
    ?? asString(record?.["gen_ai.tool.call.id"]);
  const what = asString(record?.name)
    ?? asString(record?.["zhivex.approval_name"])
    ?? asString(toolCall?.name)
    ?? asString(record?.["gen_ai.tool.name"])
    ?? asString(record?.["zhivex.tool_name"])
    ?? id;
  upsertApproval(run, {
    id,
    what,
    who: whoFrom(record) ?? whoFrom(metadata),
    whenMs,
    decision,
    reason: asString(record?.reason) ?? asString(record?.["zhivex.reason"])
  });
};

const observeTraceEvent = (run: RunDraft, value: unknown) => {
  const event = asRecord(value);
  if (!event) return;
  const whenMs = asNumber(event.timestamp);
  const data = asRecord(event.data);
  if (event.type === "approval-request") {
    observeApproval(run, { ...data, name: data?.name ?? event.name }, whenMs, "pending");
    return;
  }
  if (event.type === "approval-resolved") {
    observeApproval(run, data, whenMs, undefined);
    return;
  }
  if (event.type === "tool-approval") {
    observeApproval(run, data ? { ...data, name: data.name ?? event.name } : undefined, whenMs, undefined);
  }
};

const runIdFromAttributes = (attributes: Record<string, unknown>): string | undefined =>
  asString(attribute(attributes, "zhivex.run_id")) ?? asString(attribute(attributes, "zhivex.runId"));

const isInvokeAgentSpan = (span: RawSpan): boolean => {
  const operation = asString(attribute(span.attributes, "gen_ai.operation.name"));
  if (operation === "invoke_agent") return true;
  const name = span.name ?? "";
  return name === "invoke_agent" || name.startsWith("invoke_agent ") || name.endsWith(".run");
};

const isStepSpan = (span: RawSpan): boolean => {
  const name = span.name ?? "";
  return name === "agent_step" || name.endsWith(".step");
};

/**
 * SimpleSpanProcessor writes a finished `agent_step` before its parent run span.
 * Both carry `zhivex.run_id`, so the run identity is the invoke-agent span, not
 * whichever span with that id appears first.
 */
const selectRunIdentity = (group: RawSpan[], runId: string): RawSpan | undefined => {
  const anchored = group.filter((span) => runIdFromAttributes(span.attributes) === runId);
  const invokeSpans = (anchored.length > 0 ? anchored : group).filter(isInvokeAgentSpan);
  const pool = invokeSpans.length > 0 ? invokeSpans : anchored.filter((span) => !isStepSpan(span));
  const choice = pool.length > 0 ? pool : anchored;
  const root = choice.find((span) =>
    span.parentSpanId === undefined || !group.some((other) => other.spanId === span.parentSpanId)
  );
  return root ?? choice[0] ?? group[0];
};

const resolveRunId = (span: RawSpan, byId: Map<string, RawSpan>): string | undefined => {
  const seen = new Set<string>();
  let current: RawSpan | undefined = span;
  while (current) {
    const direct = runIdFromAttributes(current.attributes);
    if (direct) return direct;
    const parentId = current.parentSpanId;
    if (!parentId || seen.has(parentId)) return undefined;
    seen.add(parentId);
    current = byId.get(parentId);
  }
  return undefined;
};

const applySpans = (runs: Map<string, RunDraft>, spans: RawSpan[], warnings: TraceWarning[]) => {
  const byId = new Map<string, RawSpan>();
  for (const span of spans) {
    if (span.spanId) byId.set(span.spanId, span);
  }
  let skipped = 0;
  const grouped = new Map<string, RawSpan[]>();
  for (const span of spans) {
    const runId = resolveRunId(span, byId);
    if (!runId) {
      skipped += 1;
      continue;
    }
    const group = grouped.get(runId) ?? [];
    group.push(span);
    grouped.set(runId, group);
  }
  if (skipped > 0) {
    warnings.push({
      path: "spans",
      message: `${skipped} span(s) had no zhivex.run_id and were skipped.`
    });
  }

  for (const [runId, group] of grouped) {
    const run = runs.get(runId) ?? createRun(runId);
    runs.set(runId, run);
    const identity = selectRunIdentity(group, runId);
    if (identity) {
      run.provider = fillString(run.provider, asString(attribute(identity.attributes, "zhivex.provider")));
      run.modelId = fillString(
        run.modelId,
        asString(attribute(identity.attributes, "zhivex.model_id"))
          ?? asString(attribute(identity.attributes, "gen_ai.request.model"))
      );
      run.agentId = fillString(run.agentId, asString(attribute(identity.attributes, "zhivex.agent_id")));
      run.status = fillString(run.status, asString(attribute(identity.attributes, "zhivex.status")));
      run.startedAtMs = run.startedAtMs ?? identity.startTimeMs;
      run.updatedAtMs = run.updatedAtMs ?? identity.endTimeMs;
    }
    if (!run.usage) {
      const explicit = group.map((span) => {
        const usage: TokenUsageView = {
          inputTokens: asNumber(attribute(span.attributes, "zhivex.usage_input_tokens")),
          outputTokens: asNumber(attribute(span.attributes, "zhivex.usage_output_tokens")),
          totalTokens: asNumber(attribute(span.attributes, "zhivex.usage_total_tokens"))
        };
        return Object.values(usage).some((entry) => entry !== undefined) ? usage : undefined;
      }).find((usage): usage is TokenUsageView => usage !== undefined);
      const summed = group.reduce<TokenUsageView>((total, span) => {
        const input = asNumber(attribute(span.attributes, "gen_ai.usage.input_tokens"));
        const output = asNumber(attribute(span.attributes, "gen_ai.usage.output_tokens"));
        if (input !== undefined) total.inputTokens = (total.inputTokens ?? 0) + input;
        if (output !== undefined) total.outputTokens = (total.outputTokens ?? 0) + output;
        return total;
      }, {});
      const summedUsage = summed.inputTokens !== undefined || summed.outputTokens !== undefined ? summed : undefined;
      applyUsage(run, explicit ?? summedUsage);
    }

    if (run.steps.length === 0) {
      const stepSpans = group.flatMap((span) => {
        const index = asNumber(attribute(span.attributes, "zhivex.step_index"));
        if (index === undefined) return [];
        if (span.name !== "agent_step" && !span.name?.endsWith(".step")) return [];
        return [{
          index,
          status: asString(attribute(span.attributes, "zhivex.step_status")),
          startedAt: formatTimestamp(span.startTimeMs),
          finishedAt: formatTimestamp(span.endTimeMs),
          durationMs: span.startTimeMs !== undefined && span.endTimeMs !== undefined
            ? Math.max(0, span.endTimeMs - span.startTimeMs)
            : undefined,
          toolCallCount: 0,
          usage: undefined
        }];
      }).sort((left, right) => left.index - right.index);
      if (stepSpans.length > 0) run.steps = stepSpans;
    }

    for (const span of group) {
      for (const event of span.events) {
        if (event.name === "approval-request" || event.name === "approval-resolved" || event.name === "tool-approval") {
          const fallback = event.name === "approval-request" ? "pending" as const : undefined;
          observeApproval(run, event.attributes, event.timeMs, fallback);
        }
        if (event.name === "tool-start") {
          upsertTool(run, {
            id: asString(attribute(event.attributes, "gen_ai.tool.call.id")),
            name: asString(attribute(event.attributes, "gen_ai.tool.name")),
            step: asNumber(attribute(event.attributes, "zhivex.step_index")),
            argumentsSeen: false,
            resultSeen: false
          });
        }
      }
      const toolName = asString(attribute(span.attributes, "gen_ai.tool.name"));
      const toolCallId = asString(attribute(span.attributes, "gen_ai.tool.call.id"));
      const operation = asString(attribute(span.attributes, "gen_ai.operation.name"));
      if (toolName && (operation === "execute_tool" || span.name?.startsWith("execute_tool"))) {
        upsertTool(run, {
          id: toolCallId,
          name: toolName,
          step: asNumber(attribute(span.attributes, "zhivex.step")),
          status: span.statusCode === 2 ? "failed" : asBoolean(attribute(span.attributes, "zhivex.tool_error")) === true ? "failed" : undefined,
          argumentsSeen: false,
          resultSeen: false
        });
      }
    }
  }
};

const finishRun = (run: RunDraft): TraceRunView => {
  const tools = [...run.tools.values()]
    .filter((tool) => tool.name || tool.id)
    .sort((left, right) => (left.step ?? 0) - (right.step ?? 0) || (left.name ?? "").localeCompare(right.name ?? ""));
  for (const step of run.steps) {
    const matched = tools.filter((tool) => tool.step === step.index).length;
    if (step.toolCallCount === 0 && matched > 0) step.toolCallCount = matched;
  }
  const approvals = [...run.approvals.values()]
    .filter((approval) => approval.what || approval.id)
    .sort((left, right) => (left.whenMs ?? 0) - (right.whenMs ?? 0) || (left.what ?? "").localeCompare(right.what ?? ""))
    .map((approval) => ({
      id: approval.id,
      what: approval.what ?? approval.id ?? "approval",
      who: approval.who ?? WHO_NOT_RECORDED,
      when: formatTimestamp(approval.whenMs),
      decision: approval.decision ?? "pending",
      reason: approval.reason ? truncateForDisplay(approval.reason, 240) : undefined
    }));
  const stepCount = run.steps.length > 0 ? run.steps.length : run.countedSteps ?? 0;
  const stepDetail = run.steps.length > 0 ? "recorded" : run.countedSteps ? "count-only" : "none";
  return {
    runId: run.runId,
    agentId: run.agentId,
    provider: run.provider,
    modelId: run.modelId,
    status: run.status,
    startedAt: formatTimestamp(run.startedAtMs),
    updatedAt: formatTimestamp(run.updatedAtMs),
    stepCount,
    steps: run.steps,
    stepDetail,
    toolCalls: tools.map((tool) => ({
      id: tool.id,
      name: tool.name ?? tool.id ?? "tool",
      step: tool.step,
      status: tool.status,
      arguments: tool.argumentsSeen ? payloadText(tool.arguments) : OMITTED,
      result: tool.resultSeen ? payloadText(tool.result) : OMITTED
    })),
    approvals,
    usage: formatUsage(run.usage),
    cost: run.cost
  };
};

const redactSpan = (span: RawSpan): RawSpan => ({
  ...span,
  attributes: asRecord(redactTraceValue(span.attributes)) ?? {},
  events: span.events.map((event) => ({
    ...event,
    attributes: asRecord(redactTraceValue(event.attributes)) ?? {}
  }))
});

/** Build the viewer model from ledger JSON and normalized spans. Secrets are redacted. */
export const buildTraceView = (input: {
  ledgers?: unknown[];
  spans?: RawSpan[];
  warnings?: TraceWarning[];
}): TraceView => {
  const warnings = [...(input.warnings ?? [])];
  const runs = new Map<string, RunDraft>();
  for (const ledger of input.ledgers ?? []) applyLedger(runs, redactTraceValue(ledger));
  applySpans(runs, (input.spans ?? []).map(redactSpan), warnings);
  return {
    runs: [...runs.values()]
      .map(finishRun)
      .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? "") || left.runId.localeCompare(right.runId)),
    warnings
  };
};
