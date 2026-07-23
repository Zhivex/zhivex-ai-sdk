import type {
  AgentSession,
  Runner,
  RunnerRunInput,
  RunnerRunOutput,
  SessionService
} from "./runner.js";
import type { AgentApprovalRequest, AgentApprovalResponse, AgentStatus, JsonValue, LanguageModel } from "./types.js";
import type { WorkflowStateService } from "./workflow-state-service.js";
import { ValidationError } from "./errors.js";
import { createSecureId } from "./secure-id.js";

const randomId = createSecureId;
const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const WORKFLOW_RUN_STATE_SCHEMA_VERSION = 1 as const;

export type WorkflowStatus = "running" | "completed" | "waiting_approval" | "failed";
export type WorkflowStepStatus = "pending" | "running" | "completed" | "waiting_approval" | "failed";

export interface WorkflowPromptContext {
  workflowId?: string;
  runId: string;
  userId: string;
  sessionId: string;
  input?: JsonValue;
  outputs: Record<string, JsonValue>;
  steps: WorkflowStepResult[];
  step: WorkflowStep;
  metadata?: Record<string, JsonValue>;
}

export type WorkflowPrompt = string | ((context: WorkflowPromptContext) => string | Promise<string>);

export interface WorkflowLoopConditionContext {
  workflowId?: string;
  runId: string;
  userId: string;
  sessionId: string;
  input?: JsonValue;
  outputs: Record<string, JsonValue>;
  steps: WorkflowStepResult[];
  step: WorkflowLoopStep;
  iteration: number;
  result: WorkflowStepResult;
  metadata?: Record<string, JsonValue>;
}

export type WorkflowLoopCondition =
  (context: WorkflowLoopConditionContext) => boolean | Promise<boolean>;

export interface WorkflowTaskStep<TModel extends LanguageModel = LanguageModel> {
  id: string;
  kind?: "task";
  runner: Runner<TModel>;
  prompt: WorkflowPrompt;
  system?: string;
  outputKey?: string;
  metadata?: Record<string, JsonValue>;
}

export interface WorkflowParallelStep {
  id: string;
  kind: "parallel";
  steps: WorkflowTaskStep[];
  failFast?: boolean;
  metadata?: Record<string, JsonValue>;
}

export interface WorkflowLoopStep<TModel extends LanguageModel = LanguageModel> {
  id: string;
  kind: "loop";
  step: WorkflowTaskStep<TModel>;
  maxIterations: number;
  until?: WorkflowLoopCondition;
  metadata?: Record<string, JsonValue>;
}

export type WorkflowStep<TModel extends LanguageModel = LanguageModel> =
  | WorkflowTaskStep<TModel>
  | WorkflowParallelStep
  | WorkflowLoopStep<TModel>;

export interface WorkflowDefinition {
  id?: string;
  steps: WorkflowStep[];
  metadata?: Record<string, JsonValue>;
  persistence?: WorkflowPersistenceOptions;
}

export interface WorkflowPersistenceOptions {
  appName: string;
  sessionService: SessionService;
  workflowStateService?: WorkflowStateService;
  metadataKey?: string;
  workflowKey?: string;
}

export interface WorkflowRunInput {
  userId: string;
  sessionId?: string;
  input?: JsonValue;
  state?: WorkflowRunState;
  approvals?: AgentApprovalResponse[];
  sessionMetadata?: Record<string, JsonValue>;
  eventMetadata?: Record<string, JsonValue>;
  metadata?: Record<string, JsonValue>;
  resumeFromPersistedState?: boolean;
}

export interface WorkflowStepResult {
  id: string;
  kind?: "task" | "parallel" | "loop";
  status: WorkflowStepStatus;
  outputKey?: string;
  outputText?: string;
  runId?: string;
  agentStatus?: AgentStatus;
  approvals?: AgentApprovalRequest[];
  children?: WorkflowStepResult[];
  startedAt?: number;
  finishedAt?: number;
  error?: {
    message: string;
  };
  metadata?: Record<string, JsonValue>;
}

export interface WorkflowRunState {
  schemaVersion: typeof WORKFLOW_RUN_STATE_SCHEMA_VERSION;
  workflowId?: string;
  runId: string;
  userId: string;
  sessionId: string;
  status: WorkflowStatus;
  input?: JsonValue;
  outputs: Record<string, JsonValue>;
  steps: WorkflowStepResult[];
  currentStepIndex: number;
  session?: AgentSession;
  metadata?: Record<string, JsonValue>;
  createdAt: number;
  updatedAt: number;
}

export type PersistedWorkflowRunState = Omit<WorkflowRunState, "session">;
export type WorkflowRunStateMigrationTarget = typeof WORKFLOW_RUN_STATE_SCHEMA_VERSION;

export interface WorkflowStateLookup {
  userId: string;
  sessionId: string;
}

export interface WorkflowRunOutput {
  status: WorkflowStatus;
  state: WorkflowRunState;
  outputs: Record<string, JsonValue>;
  steps: WorkflowStepResult[];
  session?: AgentSession;
}

export type WorkflowReplayTimelineEvent =
  | {
      type: "workflow-start";
      runId: string;
      workflowId?: string;
      createdAt: number;
    }
  | {
      type: "step-start";
      stepId: string;
      startedAt?: number;
    }
  | {
      type: "parallel-start";
      stepId: string;
      startedAt?: number;
    }
  | {
      type: "parallel-step-finish";
      stepId: string;
      parentStepId: string;
      status: WorkflowStepStatus;
      outputText?: string;
      error?: { message: string };
      finishedAt?: number;
    }
  | {
      type: "parallel-finish";
      stepId: string;
      status: WorkflowStepStatus;
      finishedAt?: number;
    }
  | {
      type: "loop-start";
      stepId: string;
      startedAt?: number;
    }
  | {
      type: "loop-iteration-finish";
      stepId: string;
      parentStepId: string;
      iteration: number;
      status: WorkflowStepStatus;
      outputText?: string;
      error?: { message: string };
      finishedAt?: number;
    }
  | {
      type: "loop-finish";
      stepId: string;
      status: WorkflowStepStatus;
      finishedAt?: number;
    }
  | {
      type: "approval-required";
      stepId: string;
      approvals: AgentApprovalRequest[];
    }
  | {
      type: "step-finish";
      stepId: string;
      status: WorkflowStepStatus;
      outputText?: string;
      error?: { message: string };
      finishedAt?: number;
    }
  | {
      type: "workflow-finish";
      status: WorkflowStatus;
      updatedAt: number;
    };

export interface WorkflowReplayResult {
  status: WorkflowStatus;
  timeline: WorkflowReplayTimelineEvent[];
  outputs: Record<string, JsonValue>;
}

const toOutput = (state: WorkflowRunState): WorkflowRunOutput => ({
  status: state.status,
  state: cloneJson(state),
  outputs: cloneJson(state.outputs),
  steps: cloneJson(state.steps),
  session: state.session ? cloneJson(state.session) : undefined
});

const createBaseState = (workflow: WorkflowDefinition, input: WorkflowRunInput): WorkflowRunState => {
  const now = Date.now();
  return {
    schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION,
    workflowId: workflow.id,
    runId: randomId("wfr"),
    userId: input.userId,
    sessionId: input.sessionId ?? randomId("sess"),
    status: "running",
    input: input.input === undefined ? undefined : cloneJson(input.input),
    outputs: {},
    steps: [],
    currentStepIndex: 0,
    metadata: input.metadata ? cloneJson(input.metadata) : undefined,
    createdAt: now,
    updatedAt: now
  };
};

export const normalizeWorkflowRunState = (value: unknown): WorkflowRunState => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("WorkflowRunState must be an object.");
  }
  const state = value as Partial<WorkflowRunState> & { schemaVersion?: number };
  if (state.schemaVersion !== undefined && state.schemaVersion > WORKFLOW_RUN_STATE_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported WorkflowRunState schemaVersion ${state.schemaVersion}.`);
  }
  if (
    typeof state.runId !== "string" ||
    typeof state.userId !== "string" ||
    typeof state.sessionId !== "string" ||
    typeof state.status !== "string" ||
    !state.outputs ||
    typeof state.outputs !== "object" ||
    Array.isArray(state.outputs) ||
    !Array.isArray(state.steps) ||
    typeof state.currentStepIndex !== "number" ||
    typeof state.createdAt !== "number" ||
    typeof state.updatedAt !== "number"
  ) {
    throw new ValidationError("WorkflowRunState is missing required fields.");
  }
  return {
    schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION,
    workflowId: state.workflowId,
    runId: state.runId,
    userId: state.userId,
    sessionId: state.sessionId,
    status: state.status as WorkflowStatus,
    input: state.input === undefined ? undefined : cloneJson(state.input),
    outputs: cloneJson(state.outputs as Record<string, JsonValue>),
    steps: cloneJson(state.steps),
    currentStepIndex: state.currentStepIndex,
    session: state.session ? cloneJson(state.session) : undefined,
    metadata: state.metadata ? cloneJson(state.metadata) : undefined,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
};

export const migrateWorkflowRunState = (
  value: unknown,
  targetVersion: WorkflowRunStateMigrationTarget = WORKFLOW_RUN_STATE_SCHEMA_VERSION
): WorkflowRunState => {
  if (targetVersion !== WORKFLOW_RUN_STATE_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported WorkflowRunState migration target ${targetVersion}.`);
  }
  return normalizeWorkflowRunState(value);
};

const normalizeState = (state: WorkflowRunState): WorkflowRunState => normalizeWorkflowRunState(state);

const workflowPersistenceKey = (workflow: WorkflowDefinition): string =>
  workflow.persistence?.workflowKey ?? workflow.id ?? "default";

const workflowMetadataKey = (workflow: WorkflowDefinition): string =>
  workflow.persistence?.metadataKey ?? "workflowRuns";

const toPersistedWorkflowState = (state: WorkflowRunState): PersistedWorkflowRunState => {
  const { session: _session, ...persisted } = state;
  return cloneJson(persisted);
};

const getWorkflowRunsMetadata = (
  metadata: Record<string, JsonValue> | undefined,
  key: string
): Record<string, JsonValue> => {
  const value = metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneJson(value as Record<string, JsonValue>)
    : {};
};

export const loadWorkflowState = async (
  workflow: WorkflowDefinition,
  input: WorkflowStateLookup
): Promise<WorkflowRunState | undefined> => {
  const definition = validateWorkflow(workflow);
  const persistence = definition.persistence;
  if (!persistence) {
    return undefined;
  }

  if (persistence.workflowStateService) {
    const record = await persistence.workflowStateService.loadWorkflowState({
      appName: persistence.appName,
      userId: input.userId,
      sessionId: input.sessionId,
      workflowKey: workflowPersistenceKey(definition)
    });
    if (!record) {
      return undefined;
    }
    const session = await persistence.sessionService.loadSession({
      appName: persistence.appName,
      userId: input.userId,
      sessionId: input.sessionId
    });
    return {
      ...normalizeWorkflowRunState(record.state),
      session: session ? cloneJson(session) : undefined
    };
  }

  const session = await persistence.sessionService.loadSession({
    appName: persistence.appName,
    userId: input.userId,
    sessionId: input.sessionId
  });
  const runs = getWorkflowRunsMetadata(session?.metadata, workflowMetadataKey(definition));
  const persisted = runs[workflowPersistenceKey(definition)];
  if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) {
    return undefined;
  }

  return {
    ...normalizeWorkflowRunState(persisted),
    session: session ? cloneJson(session) : undefined
  };
};

export const saveWorkflowState = async (
  workflow: WorkflowDefinition,
  state: WorkflowRunState
): Promise<AgentSession | undefined> => {
  const definition = validateWorkflow(workflow);
  const persistence = definition.persistence;
  if (!persistence) {
    return undefined;
  }

  const lookup = {
    appName: persistence.appName,
    userId: state.userId,
    sessionId: state.sessionId
  };
  const existing = await persistence.sessionService.loadSession(lookup);
  const session =
    existing ??
    await persistence.sessionService.createSession({
      ...lookup,
      metadata: {}
    });

  if (persistence.workflowStateService) {
    const workflowKey = workflowPersistenceKey(definition);
    await persistence.workflowStateService.saveWorkflowState({
      ...lookup,
      workflowKey,
      state: toPersistedWorkflowState(normalizeWorkflowRunState(state))
    });
    const next: AgentSession = {
      ...session,
      updatedAt: Date.now(),
      metadata: {
        ...(session.metadata ?? {}),
        workflowStateRefs: {
          ...(
            session.metadata?.workflowStateRefs &&
            typeof session.metadata.workflowStateRefs === "object" &&
            !Array.isArray(session.metadata.workflowStateRefs)
              ? session.metadata.workflowStateRefs as Record<string, JsonValue>
              : {}
          ),
          [workflowKey]: {
            runId: state.runId,
            status: state.status,
            updatedAt: state.updatedAt
          }
        }
      }
    };
    await persistence.sessionService.saveSession(next);
    return cloneJson(next);
  }

  const metadataKey = workflowMetadataKey(definition);
  const workflowRuns = getWorkflowRunsMetadata(session.metadata, metadataKey);
  workflowRuns[workflowPersistenceKey(definition)] = toPersistedWorkflowState(normalizeWorkflowRunState(state)) as unknown as JsonValue;
  const next: AgentSession = {
    ...session,
    updatedAt: Date.now(),
    metadata: {
      ...(session.metadata ?? {}),
      [metadataKey]: workflowRuns as unknown as JsonValue
    }
  };
  await persistence.sessionService.saveSession(next);
  return cloneJson(next);
};

const resolveInitialState = async (
  workflow: WorkflowDefinition,
  input: WorkflowRunInput
): Promise<WorkflowRunState> => {
  if (input.state) {
    return normalizeState(input.state);
  }

  if (input.resumeFromPersistedState && input.sessionId) {
    const persisted = await loadWorkflowState(workflow, {
      userId: input.userId,
      sessionId: input.sessionId
    });
    if (persisted) {
      return normalizeState(persisted);
    }
  }

  return createBaseState(workflow, input);
};

const finalizeWorkflowOutput = async (
  workflow: WorkflowDefinition,
  state: WorkflowRunState
): Promise<WorkflowRunOutput> => {
  const session = await saveWorkflowState(workflow, state);
  if (session) {
    state.session = session;
  }
  return toOutput(state);
};

const setStepResult = (state: WorkflowRunState, index: number, result: WorkflowStepResult) => {
  state.steps = [...state.steps.slice(0, index), cloneJson(result)];
};

const isParallelStep = (step: WorkflowStep): step is WorkflowParallelStep => step.kind === "parallel";
const isLoopStep = (step: WorkflowStep): step is WorkflowLoopStep => step.kind === "loop";

const resolveTaskPrompt = async (
  workflow: WorkflowDefinition,
  state: WorkflowRunState,
  step: WorkflowTaskStep,
  input: WorkflowRunInput
): Promise<string> => {
  if (typeof step.prompt === "string") {
    return step.prompt;
  }

  return step.prompt({
    workflowId: workflow.id,
    runId: state.runId,
    userId: state.userId,
    sessionId: state.sessionId,
    input: state.input,
    outputs: cloneJson(state.outputs),
    steps: cloneJson(state.steps),
    step,
    metadata: input.metadata
  });
};

const createStepResult = (
  step: WorkflowTaskStep,
  status: WorkflowStepStatus,
  startedAt: number,
  output?: RunnerRunOutput,
  error?: unknown
): WorkflowStepResult => ({
  id: step.id,
  kind: "task",
  status,
  outputKey: step.outputKey,
  outputText: output?.output.steps.at(-1)?.response?.text ?? output?.output.outputText,
  runId: output?.output.state.runId,
  agentStatus: output?.output.status,
  approvals: output?.output.state.pendingApprovals.length ? cloneJson(output.output.state.pendingApprovals) : undefined,
  startedAt,
  finishedAt: Date.now(),
  error: error
    ? {
      message: error instanceof Error ? error.message : String(error)
      }
    : output?.output.error
});

const createParallelResult = (
  step: WorkflowParallelStep,
  status: WorkflowStepStatus,
  startedAt: number,
  children: WorkflowStepResult[],
  error?: { message: string }
): WorkflowStepResult => ({
  id: step.id,
  kind: "parallel",
  status,
  children: cloneJson(children),
  startedAt,
  finishedAt: Date.now(),
  error,
  metadata: step.metadata ? cloneJson(step.metadata) : undefined
});

const createLoopResult = (
  step: WorkflowLoopStep,
  status: WorkflowStepStatus,
  startedAt: number,
  children: WorkflowStepResult[],
  error?: { message: string }
): WorkflowStepResult => ({
  id: step.id,
  kind: "loop",
  status,
  children: cloneJson(children),
  startedAt,
  finishedAt: Date.now(),
  error,
  metadata: step.metadata ? cloneJson(step.metadata) : undefined
});

const stepStatusFromAgentStatus = (status: AgentStatus): WorkflowStepStatus => {
  if (status === "completed") {
    return "completed";
  }

  if (status === "waiting_approval") {
    return "waiting_approval";
  }

  return "failed";
};

const validateWorkflow = (definition: WorkflowDefinition): WorkflowDefinition => {
  if (!definition.steps.length) {
    throw new Error("Workflow must include at least one step.");
  }

  const ids = new Set<string>();
  for (const step of definition.steps) {
    if (ids.has(step.id)) {
      throw new Error(`Workflow step id "${step.id}" is duplicated.`);
    }
    ids.add(step.id);

    if (isParallelStep(step)) {
      if (!step.steps.length) {
        throw new Error(`Workflow parallel step "${step.id}" must include at least one child step.`);
      }

      for (const child of step.steps) {
        if (isParallelStep(child as WorkflowStep)) {
          throw new Error("Nested parallel workflow steps are not supported yet.");
        }
        if (ids.has(child.id)) {
          throw new Error(`Workflow step id "${child.id}" is duplicated.`);
        }
        ids.add(child.id);
      }
      continue;
    }

    if (isLoopStep(step)) {
      if (!Number.isInteger(step.maxIterations) || step.maxIterations <= 0) {
        throw new Error(`Workflow loop step "${step.id}" must include a positive integer maxIterations.`);
      }

      if ((step.step as WorkflowStep).kind === "parallel") {
        throw new Error("Workflow loop steps can only wrap task steps in this release.");
      }
      if ((step.step as WorkflowStep).kind === "loop") {
        throw new Error("Nested loop workflow steps are not supported yet.");
      }
      if (ids.has(step.step.id)) {
        throw new Error(`Workflow step id "${step.step.id}" is duplicated.`);
      }
      ids.add(step.step.id);
    }
  }

  return {
    ...definition,
    metadata: definition.metadata ? cloneJson(definition.metadata) : undefined,
    steps: definition.steps.map((step) =>
      isParallelStep(step)
        ? {
            ...step,
            metadata: step.metadata ? cloneJson(step.metadata) : undefined,
            steps: step.steps.map((child) => ({
              ...child,
              metadata: child.metadata ? cloneJson(child.metadata) : undefined
            }))
          }
        : isLoopStep(step)
          ? {
              ...step,
              metadata: step.metadata ? cloneJson(step.metadata) : undefined,
              step: {
                ...step.step,
                metadata: step.step.metadata ? cloneJson(step.step.metadata) : undefined
              }
            }
        : {
            ...step,
            metadata: step.metadata ? cloneJson(step.metadata) : undefined
          }
    )
  };
};

export const createWorkflow = (definition: WorkflowDefinition): WorkflowDefinition => validateWorkflow(definition);

const runTaskStep = async (
  workflow: WorkflowDefinition,
  state: WorkflowRunState,
  step: WorkflowTaskStep,
  input: WorkflowRunInput,
  options: {
    startedAt: number;
    isApprovalResume?: boolean;
  }
): Promise<{ result: WorkflowStepResult; output?: RunnerRunOutput }> => {
  const runnerInput: RunnerRunInput = options.isApprovalResume
    ? {
        userId: state.userId,
        sessionId: state.sessionId,
        approvals: input.approvals,
        sessionMetadata: input.sessionMetadata,
        eventMetadata: input.eventMetadata
      }
    : {
        userId: state.userId,
        sessionId: state.sessionId,
        prompt: await resolveTaskPrompt(workflow, state, step, input),
        system: step.system,
        sessionMetadata: input.sessionMetadata,
        eventMetadata: {
          ...(input.eventMetadata ?? {}),
          workflowRunId: state.runId,
          workflowStepId: step.id
        }
      };
  const output = await step.runner.run(runnerInput);
  const status = stepStatusFromAgentStatus(output.output.status);
  return {
    result: createStepResult(step, status, options.startedAt, output),
    output
  };
};

const collectStepOutputs = (
  outputs: Record<string, JsonValue>,
  step: WorkflowTaskStep,
  result: WorkflowStepResult,
  output?: RunnerRunOutput
) => {
  if (result.status === "completed" && step.outputKey) {
    outputs[step.outputKey] = result.outputText ?? output?.output.outputText ?? "";
  }
};

const runParallelStep = async (
  workflow: WorkflowDefinition,
  state: WorkflowRunState,
  step: WorkflowParallelStep,
  input: WorkflowRunInput,
  existingResult: WorkflowStepResult | undefined,
  startedAt: number
): Promise<{ result: WorkflowStepResult; session?: AgentSession }> => {
  const previousChildren = existingResult?.children ?? [];
  const hasWaitingChild = previousChildren.some((child) => child.status === "waiting_approval");
  const runnableSteps = step.steps.map((child, childIndex) => {
    const previous = previousChildren.find((result) => result.id === child.id);
    if (previous?.status === "completed") {
      return Promise.resolve({ child, childIndex, result: previous, output: undefined, skipped: true as const });
    }

    if (hasWaitingChild && previous?.status !== "waiting_approval") {
      return Promise.resolve({
        child,
        childIndex,
        result: previous ?? {
          id: child.id,
          kind: "task" as const,
          status: "pending" as const,
          outputKey: child.outputKey,
          metadata: child.metadata ? cloneJson(child.metadata) : undefined
        },
        output: undefined,
        skipped: true as const
      });
    }

    return runTaskStep(workflow, state, child, input, {
      startedAt: Date.now(),
      isApprovalResume: previous?.status === "waiting_approval" && Boolean(input.approvals?.length)
    })
      .then(({ result, output }) => ({ child, childIndex, result, output, skipped: false as const }))
      .catch((error) => ({
        child,
        childIndex,
        result: createStepResult(child, "failed", Date.now(), undefined, error),
        output: undefined,
        skipped: false as const
      }));
  });

  const settled = await Promise.allSettled(runnableSteps);
  const childRuns = settled.map((settledResult, index) => {
    if (settledResult.status === "fulfilled") {
      return settledResult.value;
    }

    const child = step.steps[index]!;
    return {
      child,
      childIndex: index,
      result: createStepResult(child, "failed", Date.now(), undefined, settledResult.reason),
      output: undefined,
      skipped: false as const
    };
  });
  const children = childRuns
    .sort((left, right) => left.childIndex - right.childIndex)
    .map((childRun) => childRun.result);

  for (const childRun of childRuns) {
    if (!childRun.skipped) {
      collectStepOutputs(state.outputs, childRun.child, childRun.result, childRun.output);
      if (childRun.output?.session) {
        state.session = childRun.output.session;
      }
    }
  }

  const waiting = children.some((child) => child.status === "waiting_approval");
  const failed = children.some((child) => child.status === "failed");
  const status: WorkflowStepStatus = waiting ? "waiting_approval" : failed ? "failed" : "completed";
  const firstError = children.find((child) => child.error)?.error;
  return {
    result: createParallelResult(
      step,
      step.failFast && failed ? "failed" : status,
      startedAt,
      children,
      firstError
    ),
    session: state.session
  };
};

const shouldStopLoop = async (
  workflow: WorkflowDefinition,
  state: WorkflowRunState,
  step: WorkflowLoopStep,
  input: WorkflowRunInput,
  iteration: number,
  result: WorkflowStepResult
): Promise<boolean> => {
  if (!step.until) {
    return false;
  }

  return step.until({
    workflowId: workflow.id,
    runId: state.runId,
    userId: state.userId,
    sessionId: state.sessionId,
    input: state.input,
    outputs: cloneJson(state.outputs),
    steps: cloneJson(state.steps),
    step,
    iteration,
    result: cloneJson(result),
    metadata: input.metadata
  });
};

const runLoopStep = async (
  workflow: WorkflowDefinition,
  state: WorkflowRunState,
  step: WorkflowLoopStep,
  input: WorkflowRunInput,
  existingResult: WorkflowStepResult | undefined,
  startedAt: number
): Promise<{ result: WorkflowStepResult; session?: AgentSession }> => {
  const previousChildren = existingResult?.children ?? [];
  const waitingIndex = previousChildren.findIndex((child) => child.status === "waiting_approval");
  const children = waitingIndex >= 0
    ? previousChildren.slice(0, waitingIndex)
    : previousChildren.filter((child) => child.status === "completed");
  const firstIteration = waitingIndex >= 0 ? waitingIndex : children.length;

  for (let iteration = firstIteration; iteration < step.maxIterations; iteration += 1) {
    const childStartedAt = Date.now();
    const isApprovalResume = waitingIndex === iteration && Boolean(input.approvals?.length);
    const { result, output } = await runTaskStep(workflow, state, step.step, input, {
      startedAt: childStartedAt,
      isApprovalResume
    }).catch((error) => ({
      result: createStepResult(step.step, "failed", childStartedAt, undefined, error),
      output: undefined
    }));
    children[iteration] = result;

    if (output?.session) {
      state.session = output.session;
    }

    if (result.status === "completed") {
      collectStepOutputs(state.outputs, step.step, result, output);
      if (await shouldStopLoop(workflow, state, step, input, iteration, result)) {
        return {
          result: createLoopResult(step, "completed", startedAt, children),
          session: state.session
        };
      }
      continue;
    }

    return {
      result: createLoopResult(
        step,
        result.status === "waiting_approval" ? "waiting_approval" : "failed",
        startedAt,
        children,
        result.error
      ),
      session: state.session
    };
  }

  return {
    result: createLoopResult(step, "completed", startedAt, children),
    session: state.session
  };
};

export const runWorkflow = async (
  workflow: WorkflowDefinition,
  input: WorkflowRunInput
): Promise<WorkflowRunOutput> => {
  const definition = validateWorkflow(workflow);
  const state = await resolveInitialState(definition, input);
  state.status = "running";
  state.updatedAt = Date.now();

  const waitingIndex = state.steps.findIndex((step) => step.status === "waiting_approval");
  if (waitingIndex >= 0 && !input.approvals?.length) {
    state.status = "waiting_approval";
    state.currentStepIndex = waitingIndex;
    state.updatedAt = Date.now();
    return finalizeWorkflowOutput(definition, state);
  }

  const startIndex = waitingIndex >= 0 ? waitingIndex : state.currentStepIndex;

  for (let index = startIndex; index < definition.steps.length; index += 1) {
    const step = definition.steps[index]!;
    const startedAt = Date.now();
    state.currentStepIndex = index;
    const existingResult = state.steps[index];
    setStepResult(
      state,
      index,
      isParallelStep(step)
        ? {
            id: step.id,
            kind: "parallel",
            status: "running",
            children: existingResult?.children,
            metadata: step.metadata ? cloneJson(step.metadata) : undefined,
            startedAt
          }
        : isLoopStep(step)
          ? {
              id: step.id,
              kind: "loop",
              status: "running",
              children: existingResult?.children,
              metadata: step.metadata ? cloneJson(step.metadata) : undefined,
              startedAt
            }
        : {
            id: step.id,
            kind: "task",
            status: "running",
            outputKey: step.outputKey,
            metadata: step.metadata ? cloneJson(step.metadata) : undefined,
            startedAt
          }
    );

    try {
      const stepRun = isParallelStep(step)
        ? await runParallelStep(definition, state, step, input, existingResult, startedAt)
        : isLoopStep(step)
          ? await runLoopStep(definition, state, step, input, existingResult, startedAt)
        : await runTaskStep(definition, state, step, input, {
            startedAt,
            isApprovalResume: index === waitingIndex && Boolean(input.approvals?.length)
          });
      const { result } = stepRun;
      const output = "output" in stepRun ? stepRun.output : undefined;
      const session = "session" in stepRun ? stepRun.session : undefined;
      if (output?.session) {
        state.session = output.session;
      } else if (session) {
        state.session = session;
      }
      const status = result.status;
      setStepResult(state, index, result);

      if (status === "completed") {
        if (!isParallelStep(step) && !isLoopStep(step)) {
          collectStepOutputs(state.outputs, step, result, output);
        }
        state.currentStepIndex = index + 1;
        state.updatedAt = Date.now();
        continue;
      }

      state.status = status === "waiting_approval" ? "waiting_approval" : "failed";
      state.currentStepIndex = index;
      state.updatedAt = Date.now();
      return finalizeWorkflowOutput(definition, state);
    } catch (error) {
      setStepResult(
        state,
        index,
        isParallelStep(step)
          ? createParallelResult(step, "failed", startedAt, existingResult?.children ?? [], {
              message: error instanceof Error ? error.message : String(error)
            })
          : isLoopStep(step)
            ? createLoopResult(step, "failed", startedAt, existingResult?.children ?? [], {
                message: error instanceof Error ? error.message : String(error)
              })
          : createStepResult(step, "failed", startedAt, undefined, error)
      );
      state.status = "failed";
      state.currentStepIndex = index;
      state.updatedAt = Date.now();
      return finalizeWorkflowOutput(definition, state);
    }
  }

  state.status = "completed";
  state.currentStepIndex = definition.steps.length;
  state.updatedAt = Date.now();
  return finalizeWorkflowOutput(definition, state);
};

export const replayWorkflowRun = (state: WorkflowRunState): WorkflowReplayResult => {
  const timeline: WorkflowReplayTimelineEvent[] = [
    {
      type: "workflow-start",
      runId: state.runId,
      workflowId: state.workflowId,
      createdAt: state.createdAt
    }
  ];

  for (const step of state.steps) {
    if (step.kind === "parallel") {
      timeline.push({
        type: "parallel-start",
        stepId: step.id,
        startedAt: step.startedAt
      });
      for (const child of step.children ?? []) {
        if (child.approvals?.length) {
          timeline.push({
            type: "approval-required",
            stepId: child.id,
            approvals: cloneJson(child.approvals)
          });
        }
        timeline.push({
          type: "parallel-step-finish",
          stepId: child.id,
          parentStepId: step.id,
          status: child.status,
          outputText: child.outputText,
          error: child.error,
          finishedAt: child.finishedAt
        });
      }
      timeline.push({
        type: "parallel-finish",
        stepId: step.id,
        status: step.status,
        finishedAt: step.finishedAt
      });
      if (step.approvals?.length) {
        timeline.push({
          type: "approval-required",
          stepId: step.id,
          approvals: cloneJson(step.approvals)
        });
      }
      continue;
    }

    if (step.kind === "loop") {
      timeline.push({
        type: "loop-start",
        stepId: step.id,
        startedAt: step.startedAt
      });
      for (const [index, child] of (step.children ?? []).entries()) {
        if (child.approvals?.length) {
          timeline.push({
            type: "approval-required",
            stepId: child.id,
            approvals: cloneJson(child.approvals)
          });
        }
        timeline.push({
          type: "loop-iteration-finish",
          stepId: child.id,
          parentStepId: step.id,
          iteration: index,
          status: child.status,
          outputText: child.outputText,
          error: child.error,
          finishedAt: child.finishedAt
        });
      }
      timeline.push({
        type: "loop-finish",
        stepId: step.id,
        status: step.status,
        finishedAt: step.finishedAt
      });
      if (step.approvals?.length) {
        timeline.push({
          type: "approval-required",
          stepId: step.id,
          approvals: cloneJson(step.approvals)
        });
      }
      continue;
    }

    timeline.push({
      type: "step-start",
      stepId: step.id,
      startedAt: step.startedAt
    });
    if (step.approvals?.length) {
      timeline.push({
        type: "approval-required",
        stepId: step.id,
        approvals: cloneJson(step.approvals)
      });
    }
    timeline.push({
      type: "step-finish",
      stepId: step.id,
      status: step.status,
      outputText: step.outputText,
      error: step.error,
      finishedAt: step.finishedAt
    });
  }

  timeline.push({
    type: "workflow-finish",
    status: state.status,
    updatedAt: state.updatedAt
  });

  return {
    status: state.status,
    timeline,
    outputs: cloneJson(state.outputs)
  };
};
