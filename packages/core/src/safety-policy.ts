import { getHostedToolClass, isHostedToolDefinition } from "./messages.js";
import type {
  AgentDefinition,
  AgentGuardrailTrigger,
  AgentInputGuardrail,
  AgentOutputGuardrail,
  AgentRunOutput,
  AgentRunState,
  JsonValue,
  ModelMessage,
  TokenUsage,
  ToolApprovalDecision,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  ToolExecutionOptions
} from "./types.js";

export type SafetyPolicyPreset = "permissive" | "review-sensitive" | "locked-down";
export type ApprovalPolicyPreset = SafetyPolicyPreset;

export interface RedactionRule {
  name?: string;
  pattern: RegExp | string;
  replacement?: string;
}

export interface RedactionPolicyOptions {
  rules?: RedactionRule[];
  includeEmails?: boolean;
  replacement?: string;
}

export interface RedactionPolicy {
  rules: RedactionRule[];
  redactText(text: string): string;
  redactJson<T extends JsonValue | undefined>(value: T): T;
  redactMessages(messages: ModelMessage[]): ModelMessage[];
  inputGuardrail: AgentInputGuardrail;
  outputGuardrail: AgentOutputGuardrail;
}

export interface BudgetGuardOptions {
  maxSteps?: number;
  maxToolCalls?: number;
  maxToolErrors?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  includeChildRuns?: boolean;
}

export interface BudgetGuard {
  limits: BudgetGuardOptions;
  inputGuardrail: AgentInputGuardrail;
  outputGuardrail: AgentOutputGuardrail;
}

export interface ApprovalPolicyOptions {
  preset?: ApprovalPolicyPreset;
  sensitiveToolNames?: string[];
  allowToolNames?: string[];
  denyToolNames?: string[];
}

export interface SafetyPolicy {
  preset: SafetyPolicyPreset;
  toolApprovalPolicy?: ToolApprovalPolicy;
  inputGuardrails?: AgentInputGuardrail[];
  outputGuardrails?: AgentOutputGuardrail[];
  toolExecution?: ToolExecutionOptions;
  redaction?: RedactionPolicy;
  budget?: BudgetGuard;
}

export interface SafetyPolicyOptions {
  preset?: SafetyPolicyPreset;
  approval?: ApprovalPolicyOptions | ToolApprovalPolicy | false;
  redaction?: RedactionPolicyOptions | RedactionPolicy | false;
  budget?: BudgetGuardOptions | BudgetGuard | false;
  toolExecution?: ToolExecutionOptions;
  inputGuardrails?: AgentInputGuardrail[];
  outputGuardrails?: AgentOutputGuardrail[];
}

const defaultRedactionRules: RedactionRule[] = [
  {
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
  },
  {
    name: "basic-auth",
    pattern: /\bBasic\s+[A-Za-z0-9+/=-]+/gi
  },
  {
    name: "api-key",
    pattern: /\b(?:api[_-]?key|apikey|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi
  }
];

const emailRule: RedactionRule = {
  name: "email",
  pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
};

const sensitiveToolNames = new Set([
  "delete",
  "delete_file",
  "write_file",
  "write",
  "exec",
  "execute",
  "shell",
  "bash",
  "terminal",
  "code",
  "apply_patch",
  "http",
  "request",
  "post",
  "deploy"
]);

const sensitivePermissions = new Set([
  "write",
  "filesystem",
  "code-execution",
  "shell",
  "external-side-effect",
  "network"
]);

const sensitiveHostedClasses = new Set([
  "computer-use",
  "code-execution",
  "shell",
  "apply-patch",
  "remote-mcp",
  "toolset"
]);

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const normalizeDecision = (decision: ToolApprovalDecision | boolean | undefined): ToolApprovalDecision =>
  typeof decision === "boolean" ? { approved: decision } : decision ?? { approved: true };

const approvalMetadata = (preset: ApprovalPolicyPreset, highRisk?: boolean): Record<string, JsonValue> => ({
  preset,
  ...(highRisk === undefined ? {} : { highRisk })
});

const combineApprovalPolicies = (
  first: ToolApprovalPolicy | undefined,
  second: ToolApprovalPolicy | undefined
): ToolApprovalPolicy | undefined => {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }

  return async (request) => {
    const firstDecision = normalizeDecision(await first(request));
    if (!firstDecision.approved) {
      return firstDecision;
    }

    const secondDecision = normalizeDecision(await second(request));
    return secondDecision.approved
      ? {
          approved: true,
          metadata: {
            ...(firstDecision.metadata ?? {}),
            ...(secondDecision.metadata ?? {})
          }
        }
      : secondDecision;
  };
};

const getAdvancedRegistryMetadata = (request: ToolApprovalRequest): Record<string, JsonValue> | undefined => {
  const metadata = request.tool.metadata?.advancedRegistry;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, JsonValue>
    : undefined;
};

const isHighRiskTool = (request: ToolApprovalRequest, extraSensitiveNames: Set<string>) => {
  if (request.tool.requiresApproval) {
    return true;
  }

  const normalizedName = request.tool.name.toLowerCase();
  if (sensitiveToolNames.has(normalizedName) || extraSensitiveNames.has(normalizedName)) {
    return true;
  }

  if (isHostedToolDefinition(request.tool) && sensitiveHostedClasses.has(getHostedToolClass(request.tool))) {
    return true;
  }

  const advanced = getAdvancedRegistryMetadata(request);
  const permissions = Array.isArray(advanced?.permissions) ? advanced.permissions : [];
  if (permissions.some((permission) => typeof permission === "string" && sensitivePermissions.has(permission))) {
    return true;
  }

  const audit = advanced?.audit;
  if (audit && typeof audit === "object" && !Array.isArray(audit)) {
    const riskLevel = (audit as Record<string, JsonValue>).riskLevel;
    if (riskLevel === "high" || riskLevel === "critical") {
      return true;
    }
  }

  return false;
};

export const createApprovalPolicy = (options: ApprovalPolicyOptions = {}): ToolApprovalPolicy => {
  const preset = options.preset ?? "review-sensitive";
  const extraSensitiveNames = new Set((options.sensitiveToolNames ?? []).map((name) => name.toLowerCase()));
  const allowNames = new Set((options.allowToolNames ?? []).map((name) => name.toLowerCase()));
  const denyNames = new Set((options.denyToolNames ?? []).map((name) => name.toLowerCase()));

  return (request) => {
    const toolName = request.tool.name.toLowerCase();
    if (denyNames.has(toolName)) {
      return {
        approved: false,
        reason: `Tool "${request.tool.name}" is denied by the approval policy.`,
        metadata: approvalMetadata(preset)
      };
    }

    if (allowNames.has(toolName) || preset === "permissive") {
      return {
        approved: true,
        metadata: approvalMetadata(preset)
      };
    }

    const highRisk = isHighRiskTool(request, extraSensitiveNames);
    if (preset === "locked-down" || highRisk) {
      return {
        approved: false,
        reason: highRisk
          ? `Tool "${request.tool.name}" requires approval under the "${preset}" policy.`
          : `Tool "${request.tool.name}" is blocked by the "${preset}" policy.`,
        metadata: approvalMetadata(preset, highRisk)
      };
    }

    return {
      approved: true,
      metadata: approvalMetadata(preset, false)
    };
  };
};

const compileRule = (rule: RedactionRule): { pattern: RegExp; replacement: string } => ({
  pattern: typeof rule.pattern === "string" ? new RegExp(rule.pattern, "g") : rule.pattern,
  replacement: rule.replacement ?? "[REDACTED]"
});

export const createRedactionPolicy = (options: RedactionPolicyOptions = {}): RedactionPolicy => {
  const replacement = options.replacement ?? "[REDACTED]";
  const rules = [
    ...defaultRedactionRules.map((rule) => ({ ...rule, replacement })),
    ...(options.includeEmails ? [{ ...emailRule, replacement }] : []),
    ...(options.rules ?? []).map((rule) => ({ ...rule, replacement: rule.replacement ?? replacement }))
  ];
  const compiled = rules.map(compileRule);

  const redactText = (text: string) =>
    compiled.reduce((current, rule) => current.replace(rule.pattern, rule.replacement), text);

  const redactUnknown = (value: unknown): unknown => {
    if (typeof value === "string") {
      return redactText(value);
    }
    if (Array.isArray(value)) {
      return value.map(redactUnknown);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactUnknown(item)]));
    }
    return value;
  };

  const redactJson = <T extends JsonValue | undefined>(value: T): T =>
    value === undefined ? value : redactUnknown(value) as T;

  const redactMessages = (messages: ModelMessage[]): ModelMessage[] => redactUnknown(cloneJson(messages)) as ModelMessage[];

  return {
    rules,
    redactText,
    redactJson,
    redactMessages,
    inputGuardrail: (request) => {
      request.messages.splice(0, request.messages.length, ...redactMessages(request.messages));
      if (request.metadata) {
        Object.assign(request.metadata, redactJson(request.metadata));
      }
    },
    outputGuardrail: (request) => {
      request.state.messages = redactMessages(request.state.messages);
      request.output.messages = redactMessages(request.output.messages);
      request.output.outputText = redactText(request.output.outputText);
      request.state.outputText = redactText(request.state.outputText);
      if (request.state.metadata) {
        request.state.metadata = redactJson(request.state.metadata);
      }
    }
  };
};

const countToolCalls = (state: AgentRunState) =>
  state.steps.reduce(
    (total, step) =>
      total +
      (step.response?.messages.reduce(
        (messageTotal, message) =>
          messageTotal + message.parts.filter((part) => part.type === "tool-call").length,
        0
      ) ?? 0),
    0
  );

const budgetFailure = (reason: string, metadata: Record<string, JsonValue>): AgentGuardrailTrigger => ({
  triggered: true,
  reason,
  metadata
});

const addUsage = (usage: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined => {
  if (!usage && !next) {
    return undefined;
  }

  return {
    inputTokens: (usage?.inputTokens ?? 0) + (next?.inputTokens ?? 0) || undefined,
    cachedInputTokens: (usage?.cachedInputTokens ?? 0) + (next?.cachedInputTokens ?? 0) || undefined,
    cacheWriteTokens: (usage?.cacheWriteTokens ?? 0) + (next?.cacheWriteTokens ?? 0) || undefined,
    outputTokens: (usage?.outputTokens ?? 0) + (next?.outputTokens ?? 0) || undefined,
    reasoningTokens: (usage?.reasoningTokens ?? 0) + (next?.reasoningTokens ?? 0) || undefined,
    totalTokens: (usage?.totalTokens ?? 0) + (next?.totalTokens ?? 0) || undefined
  };
};

const evaluateBudget = (state: AgentRunState, output: { usage?: AgentRunOutput["usage"] } | undefined, limits: BudgetGuardOptions) => {
  const includeChildRuns = limits.includeChildRuns ?? true;
  const childRuns = includeChildRuns ? state.childRuns ?? [] : [];
  const usage = childRuns.reduce((total, childRun) => addUsage(total, childRun.usage), output?.usage ?? state.usage);
  const toolErrors = state.toolResults.filter((result) => result.isError).length + childRuns.reduce((total, childRun) => total + childRun.toolErrors, 0);
  const toolCalls = countToolCalls(state) + childRuns.reduce((total, childRun) => total + childRun.toolCalls, 0);
  const steps = state.currentStep + childRuns.reduce((total, childRun) => total + childRun.steps, 0);
  const checks = [
    ["maxSteps", steps, limits.maxSteps],
    ["maxToolCalls", toolCalls, limits.maxToolCalls],
    ["maxToolErrors", toolErrors, limits.maxToolErrors],
    ["maxInputTokens", usage?.inputTokens, limits.maxInputTokens],
    ["maxOutputTokens", usage?.outputTokens, limits.maxOutputTokens],
    ["maxTotalTokens", usage?.totalTokens, limits.maxTotalTokens]
  ] as const;

  for (const [name, actual, limit] of checks) {
    if (limit !== undefined && actual !== undefined && actual > limit) {
      const scope = includeChildRuns ? " including child runs" : "";
      return budgetFailure(`Agent budget exceeded${scope}: ${name} limit ${limit}, actual ${actual}.`, {
        budgetLimit: name,
        limit,
        actual,
        includeChildRuns
      });
    }
  }

  return undefined;
};

export const createBudgetGuard = (limits: BudgetGuardOptions): BudgetGuard => ({
  limits: { ...limits },
  inputGuardrail: () => undefined,
  outputGuardrail: (request) => evaluateBudget(request.state, "usage" in request.output ? request.output : undefined, limits)
});

const isRedactionPolicy = (value: RedactionPolicyOptions | RedactionPolicy): value is RedactionPolicy =>
  "redactText" in value && typeof value.redactText === "function";

const isBudgetGuard = (value: BudgetGuardOptions | BudgetGuard): value is BudgetGuard =>
  "outputGuardrail" in value && typeof value.outputGuardrail === "function";

const productionBudgetDefaults: BudgetGuardOptions = {
  maxSteps: 6,
  maxToolCalls: 8,
  maxToolErrors: 1,
  maxTotalTokens: 20_000
};

export const createSafetyPolicy = (options: SafetyPolicyOptions = {}): SafetyPolicy => {
  const preset = options.preset ?? "review-sensitive";
  const redaction =
    options.redaction === false
      ? undefined
      : options.redaction && isRedactionPolicy(options.redaction)
        ? options.redaction
        : createRedactionPolicy({
            includeEmails: preset === "locked-down",
            ...(typeof options.redaction === "object" ? options.redaction : {})
          });
  const budget =
    options.budget === false || !options.budget
      ? undefined
      : isBudgetGuard(options.budget)
        ? options.budget
        : createBudgetGuard(options.budget);
  const approval =
    options.approval === false
      ? undefined
      : typeof options.approval === "function"
        ? options.approval
        : createApprovalPolicy({
            preset,
            ...(typeof options.approval === "object" ? options.approval : {})
          });

  return {
    preset,
    toolApprovalPolicy: approval,
    toolExecution: {
      ...(preset === "locked-down" ? { parallel: false, stopOnError: true } : {}),
      ...(options.toolExecution ?? {})
    },
    redaction,
    budget,
    inputGuardrails: [
      ...(redaction ? [redaction.inputGuardrail] : []),
      ...(budget ? [budget.inputGuardrail] : []),
      ...(options.inputGuardrails ?? [])
    ],
    outputGuardrails: [
      ...(redaction ? [redaction.outputGuardrail] : []),
      ...(budget ? [budget.outputGuardrail] : []),
      ...(options.outputGuardrails ?? [])
    ]
  };
};

export const applySafetyPolicyToAgent = <TModel extends AgentDefinition["model"]>(
  agent: AgentDefinition<TModel>,
  policy: SafetyPolicy
): AgentDefinition<TModel> => ({
  ...agent,
  toolApprovalPolicy: combineApprovalPolicies(policy.toolApprovalPolicy, agent.toolApprovalPolicy),
  inputGuardrails: [...(policy.inputGuardrails ?? []), ...(agent.inputGuardrails ?? [])],
  outputGuardrails: [...(policy.outputGuardrails ?? []), ...(agent.outputGuardrails ?? [])],
  toolExecution: {
    ...(agent.toolExecution ?? {}),
    ...(policy.toolExecution ?? {})
  },
  maxSteps:
    policy.budget?.limits.maxSteps === undefined
      ? agent.maxSteps
      : Math.min(agent.maxSteps ?? policy.budget.limits.maxSteps, policy.budget.limits.maxSteps)
});

export const createProductionSafetyPolicy = (options: SafetyPolicyOptions = {}): SafetyPolicy => {
  const redaction =
    options.redaction && typeof options.redaction === "object" && !isRedactionPolicy(options.redaction)
      ? { includeEmails: true, ...options.redaction }
      : options.redaction === undefined
        ? { includeEmails: true }
        : options.redaction;
  const budget =
    options.budget && typeof options.budget === "object" && !isBudgetGuard(options.budget)
      ? { ...productionBudgetDefaults, ...options.budget }
      : options.budget === undefined
        ? productionBudgetDefaults
        : options.budget;

  return createSafetyPolicy({
    preset: "review-sensitive",
    ...options,
    redaction,
    budget
  });
};
