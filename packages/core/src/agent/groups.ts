import {
  ConflictError,
  ValidationError
} from "../errors.js";
import {
  createMergedAbortSignal
} from "../runtime.js";
import type {
  AgentDefinition,
  AgentGroupMember,
  AgentGroupRunInput,
  AgentGroupRunOutput,
  AgentRunInput,
  AgentRunOutput
} from "../types.js";
import {
  cloneMetadata
} from "./common.js";
import {
  ensureValidIdempotencyInput,
  ensureValidScope
} from "./context.js";
import {
  runAgent
} from "./execution.js";

const AGENT_GROUP_FAIL_FAST_ABORT_MESSAGE = "Agent group member aborted after fail-fast.";

export const runAgentGroup = async (
  agents: AgentGroupMember[],
  input: AgentGroupRunInput = {}
): Promise<AgentGroupRunOutput> => {
  const { stopOnError, maxConcurrency, runId: _runId, state: _state, approvals: _approvals, handoff: _handoff, ...sharedInput } = input;
  if (maxConcurrency !== undefined && (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1)) {
    throw new ValidationError('Agent group "maxConcurrency" must be a positive safe integer.');
  }
  // Validate the complete group before any member can claim a key or invoke a model.
  const identities = new Set<string>();
  const claims: Array<{ store: AgentDefinition["store"]; key: string }> = [];
  const memberInputs = agents.map((member) => {
    const merged = { ...sharedInput, ...member.input } as AgentRunInput;
    ensureValidScope(merged.scope);
    ensureValidIdempotencyInput(merged, member.agent.store);
    if (!merged.idempotencyKey) return merged;
    const identity = member.name ?? member.agent.id;
    if (!identity || identities.has(identity)) {
      throw new ValidationError("Idempotent agent group members require unique names or agent IDs.");
    }
    identities.add(identity);
    const key = member.input?.idempotencyKey ?? `agent-group:${JSON.stringify([input.idempotencyKey, identity])}`;
    const scope = merged.scope;
    const scopedKey = JSON.stringify([scope?.namespace ?? "default", scope?.tenantId, scope?.userId, key]);
    if (claims.some((claim) => claim.store === member.agent.store && claim.key === scopedKey)) {
      throw new ConflictError("Agent group members cannot share an explicit idempotency key in the same store and scope.");
    }
    claims.push({ store: member.agent.store, key: scopedKey });
    return {
      ...merged,
      idempotencyKey: key,
      metadata: cloneMetadata(input.metadata, member.input?.metadata, {
        agentGroupIdentity: JSON.stringify([input.idempotencyKey ?? null, identity])
      })
    };
  });
  const parentRunId = input.parentRunId;
  const controllers = agents.map(() => new AbortController());
  let failFastTriggered = false;
  const isFailingOutput = (output: AgentRunOutput) => output.status === "failed" || output.status === "timed_out";
  const abortPending = (currentIndex: number) => {
    if (!stopOnError || failFastTriggered) {
      return;
    }
    failFastTriggered = true;
    controllers.forEach((controller, index) => {
      if (index !== currentIndex) {
        controller.abort();
      }
    });
  };

  const runMember = async (member: AgentGroupMember, index: number) => {
    const merged = createMergedAbortSignal(
      input.abortSignal,
      member.input?.abortSignal,
      controllers[index]!.signal
    );
    try {
      if (merged.signal?.aborted) {
        throw new DOMException("Agent group member aborted before execution.", "AbortError");
      }
      const runInput = {
        ...memberInputs[index],
        parentRunId: member.input?.parentRunId ?? parentRunId,
        abortSignal: merged.signal,
        metadata: cloneMetadata(input.metadata, memberInputs[index]?.metadata, {
          ...(member.name ? { agentGroupMember: member.name } : {})
        })
      } as AgentRunInput;
      const output = await runAgent(member.agent, runInput);
      if (isFailingOutput(output)) {
        abortPending(index);
      }
      return output;
    } catch (error) {
      abortPending(index);
      throw error;
    } finally {
      merged.cleanup();
    }
  };
  const settled: PromiseSettledResult<AgentRunOutput>[] = new Array(agents.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(maxConcurrency ?? agents.length, agents.length) }, async () => {
    while (nextIndex < agents.length) {
      const index = nextIndex++;
      try {
        settled[index] = { status: "fulfilled", value: await runMember(agents[index]!, index) };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  }));
  const outputs = settled.map((result, index) => {
    const member = agents[index]!;
    if (result.status === "fulfilled") {
      return {
        name: member.name,
        agentId: result.value.state.agentId ?? member.agent.id,
        status: "fulfilled" as const,
        output: result.value
      };
    }

    return {
      name: member.name,
      agentId: member.agent.id,
      status: "rejected" as const,
      error: {
        message:
          stopOnError && failFastTriggered && controllers[index]!.signal.aborted
            ? AGENT_GROUP_FAIL_FAST_ABORT_MESSAGE
            : result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
      }
    };
  });
  const precedence: AgentRunOutput["status"][] = [
    "failed", "timed_out", "cancel_requested", "running", "queued", "waiting_approval", "suspended", "cancelled", "completed"
  ];
  const status = precedence.find((status) => outputs.some((output) =>
    output.status === "rejected" ? status === "failed" : output.output?.status === status
  )) ?? "completed";

  return {
    status,
    parentRunId,
    outputs
  };
};
