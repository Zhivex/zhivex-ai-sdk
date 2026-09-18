import {
  createHash
} from "node:crypto";
import {
  createAgentExecutionEnvironmentBinding
} from "../agent-harness.js";
import {
  ConflictError,
  GuardrailTriggeredError,
  ValidationError
} from "../errors.js";
import {
  serializeJsonValue
} from "../messages.js";
import type {
  AgentDefinition,
  AgentExecutionEnvironment,
  AgentExecutionEnvironmentSession,
  AgentRunState,
  AgentToolCallJournalEntry,
  JsonValue,
  LanguageModel,
  ToolDefinition,
  ToolExecutionContext,
  ToolInputGuardrail
} from "../types.js";

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
};

export const durableToolCallId = (
  runId: string,
  step: number,
  providerToolCallId: string,
  toolName: string,
  input: JsonValue
): string =>
  `tool_${createHash("sha256")
    .update(`${runId}\0${step}\0${providerToolCallId}\0${toolName}\0${canonicalJson(input)}`)
    .digest("hex")}`;

export const wrapToolWithExecutionEnvironment = (
  tool: ToolDefinition,
  session: AgentExecutionEnvironmentSession
): ToolDefinition => {
  const authorize = async (
    input: unknown,
    context: ToolExecutionContext,
    phase: "preflight" | "execute"
  ) => session.authorize({
    manifest: session.manifest,
    binding: session.binding,
    tool,
    toolCall: context.toolCall,
    input,
    context,
    phase
  });
  const environmentGuardrail: ToolInputGuardrail = async ({ input, context }) => {
    const decision = await authorize(input, context, "preflight");
    return decision.decision === "deny"
      ? {
          triggered: true,
          reason: decision.reason,
          metadata: decision.metadata
        }
      : undefined;
  };

  return {
    ...tool,
    approvalVersion: [
      tool.approvalVersion,
      `environment:${session.binding.fingerprint}`
    ].filter(Boolean).join("|"),
    inputGuardrails: [
      environmentGuardrail,
      ...(tool.inputGuardrails ?? [])
    ],
    execute: async (input, context) => {
      if (!context) {
        throw new ValidationError(`Tool "${tool.name}" requires an execution environment context.`);
      }
      const decision = await authorize(input, context, "execute");
      if (decision.decision === "deny") {
        throw new GuardrailTriggeredError(
          "tool-input",
          decision.reason,
          { metadata: decision.metadata }
        );
      }
      const request = {
        manifest: session.manifest,
        binding: session.binding,
        tool,
        toolCall: context.toolCall,
        input,
        context,
        phase: "execute" as const
      };
      return session.execute(request, () => tool.execute(input, context));
    }
  } as ToolDefinition;
};

export const wrapToolWithJournal = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  tool: ToolDefinition
): ToolDefinition => {
  const store = agent.store;
  if (!store?.claimToolExecution || !store.loadToolExecution || !store.completeToolExecution) {
    return tool;
  }

  return {
    ...tool,
    execute: async (input, context) => {
      if (!context) {
        throw new ValidationError(`Durable tool "${tool.name}" requires an execution context.`);
      }
      const serializedInput = serializeJsonValue(input);
      const confirmed = state.reconciliations?.find(record => record.evidence.toolName === tool.name && canonicalJson(record.evidence.input) === canonicalJson(serializedInput));
      if (confirmed) return confirmed.evidence.output;
      const step = context.step;
      const toolCallId = durableToolCallId(state.runId, step, context.toolCall.id, tool.name, serializedInput);
      const idempotencyKey = `${state.runId}:${toolCallId}`;
      const now = Date.now();
      const candidate = {
        runId: state.runId,
        scope: state.scope,
        toolCallId,
        providerToolCallId: context.toolCall.id,
        toolName: tool.name,
        status: "pending",
        idempotencyKey,
        revision: 0,
        input: serializedInput,
        updatedAt: now
      } satisfies AgentToolCallJournalEntry;
      const claim = await store.claimToolExecution!(candidate);

      if (!claim.claimed) {
        if (claim.entry.status === "completed") {
          return claim.entry.output ?? null;
        }
        if (claim.entry.status === "failed") {
          throw new Error(claim.entry.error?.message ?? `Tool "${tool.name}" previously failed.`);
        }
        throw new ConflictError(
          `Tool "${tool.name}" has an indeterminate durable execution. Reconcile idempotency key "${claim.entry.idempotencyKey}" before retrying.`
        );
      }

      try {
        const output = serializeJsonValue(
          await tool.execute(input, {
            ...context,
            runId: state.runId,
            idempotencyKey
          })
        );
        await store.completeToolExecution!(
          {
            ...claim.entry,
            status: "completed",
            output,
            completedAt: Date.now(),
            updatedAt: Date.now()
          },
          { expectedRevision: claim.entry.revision }
        );
        return output;
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        try {
          await store.completeToolExecution!(
            {
              ...claim.entry,
              status: "failed",
              error: { message: normalizedError.message },
              completedAt: Date.now(),
              updatedAt: Date.now()
            },
            { expectedRevision: claim.entry.revision }
          );
        } catch {
          // The original error is more useful; a running journal row blocks unsafe replay.
        }
        throw normalizedError;
      }
    }
  };
};

export const acquireExecutionEnvironment = async <TContext>(
  environment: AgentExecutionEnvironment<TContext> | undefined,
  state: AgentRunState,
  context: TContext | undefined,
  abortSignal: AbortSignal | undefined
): Promise<AgentExecutionEnvironmentSession<TContext> | undefined> => {
  if (!environment) {
    return undefined;
  }
  const expected = state.executionEnvironment;
  if (!expected) {
    throw new ConflictError(`Agent run "${state.runId}" has no durable execution-environment binding.`);
  }
  const session = await environment.acquire({
    runId: state.runId,
    agentId: state.agentId,
    scope: state.scope,
    context,
    metadata: state.metadata,
    abortSignal
  });
  const manifestBinding = createAgentExecutionEnvironmentBinding(session.manifest);
  if (
    session.binding.environmentId !== expected.environmentId ||
    session.binding.environmentVersion !== expected.environmentVersion ||
    session.binding.fingerprint !== expected.fingerprint ||
    session.binding.workspaceId !== expected.workspaceId ||
    manifestBinding.fingerprint !== expected.fingerprint
  ) {
    await session.release?.({
      status: "failed",
      error: { message: "Execution environment returned a binding that differs from the durable run." }
    });
    throw new ConflictError(`Execution environment binding changed for agent run "${state.runId}".`);
  }
  return session;
};
