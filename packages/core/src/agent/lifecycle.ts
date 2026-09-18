import {
  normalizeAgentRunState
} from "../agent-state.js";
import {
  ConflictError,
  ValidationError
} from "../errors.js";
import {
  createMergedAbortSignal
} from "../runtime.js";
import type {
  AgentDefinition,
  AgentRunInput,
  AgentRunState,
  AgentRunPolicy,
  LanguageModel
} from "../types.js";
import {
  randomId
} from "./common.js";

const DEFAULT_AGENT_LEASE_TTL_MS = 30_000;

const DEFAULT_AGENT_CANCELLATION_POLL_MS = 1_000;

const DEFAULT_AGENT_MONITOR_SHUTDOWN_TIMEOUT_MS = 1_000;

export class AgentPolicyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent run timed out after ${timeoutMs}ms.`);
    this.name = "AgentPolicyTimeoutError";
  }
}

export const resolveRunPolicy = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel>
): AgentRunPolicy | undefined => {
  const policy = {
    ...(agent.policy ?? {}),
    ...(input.policy ?? {})
  };
  return Object.keys(policy).length ? policy : undefined;
};

export const withAgentPolicyTimeout = async <T>(
  operation: Promise<T>,
  timeout: {
    signal?: AbortSignal;
    timeoutPromise?: Promise<never>;
    cleanup: () => void;
    isTimedOut: () => boolean;
  }
): Promise<T> => {
  try {
    return timeout.timeoutPromise
      ? await Promise.race([operation, timeout.timeoutPromise])
      : await operation;
  } finally {
    timeout.cleanup();
  }
};

export const createAgentAbortContext = (
  inputAbortSignal: AbortSignal | undefined,
  policy: AgentRunPolicy | undefined,
  ...additionalSignals: Array<AbortSignal | undefined>
) => {
  if (!policy?.timeoutMs) {
    const merged = createMergedAbortSignal(inputAbortSignal, ...additionalSignals);
    return {
      signal: merged.signal,
      timeoutPromise: undefined,
      cleanup: merged.cleanup,
      isTimedOut: () => false
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new AgentPolicyTimeoutError(policy.timeoutMs!));
    }, policy.timeoutMs);
  });

  const merged = createMergedAbortSignal(inputAbortSignal, ...additionalSignals, controller.signal);
  return {
    signal: merged.signal,
    timeoutPromise,
    cleanup: () => {
      merged.cleanup();
      if (timeout) {
        clearTimeout(timeout);
      }
    },
    isTimedOut: () => timedOut
  };
};

export interface AgentExecutionLeaseContext {
  supported: boolean;
  signal?: AbortSignal;
  cancelledState: () => AgentRunState | undefined;
  leaseLost: () => boolean;
  release: () => Promise<void>;
}

const waitForAgentMonitorShutdown = async (monitor: Promise<void>, timeoutMs: number) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([monitor, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const acquireAgentExecutionLease = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  policy: AgentRunPolicy | undefined
): Promise<AgentExecutionLeaseContext | undefined> => {
  const store = agent.store;
  if (policy?.leaseMode === "disabled" || !store?.acquireLease || !store.renewLease || !store.releaseLease) {
    return {
      supported: false,
      cancelledState: () => undefined,
      leaseLost: () => false,
      release: async () => undefined
    };
  }

  const ttlMs = policy?.leaseTtlMs ?? DEFAULT_AGENT_LEASE_TTL_MS;
  const heartbeatMs = policy?.heartbeatMs ?? Math.max(250, Math.floor(ttlMs / 3));
  const cancellationPollMs = policy?.cancellationPollMs ?? DEFAULT_AGENT_CANCELLATION_POLL_MS;
  for (const [name, value] of [
    ["leaseTtlMs", ttlMs],
    ["heartbeatMs", heartbeatMs],
    ["cancellationPollMs", cancellationPollMs]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ValidationError(`Agent policy "${name}" must be a positive integer.`);
    }
  }
  if (heartbeatMs >= ttlMs) {
    throw new ValidationError('Agent policy "heartbeatMs" must be less than "leaseTtlMs".');
  }

  const ownerId = randomId("worker");
  const lease = await store.acquireLease(state.runId, { ownerId, ttlMs }, state.scope);
  if (!lease) {
    return undefined;
  }

  const controller = new AbortController();
  let cancelled: AgentRunState | undefined;
  let lost = false;
  let stopped = false;
  let activeMonitor: Promise<void> | undefined;
  let lastHeartbeat = Date.now();
  let lastCancellationPoll = 0;
  const intervalMs = Math.max(25, Math.min(heartbeatMs, cancellationPollMs));
  const monitorShutdownTimeoutMs = Math.min(ttlMs, DEFAULT_AGENT_MONITOR_SHUTDOWN_TIMEOUT_MS);
  const cleanupStoppedMonitorLease = async () => {
    try {
      await store.releaseLease?.(state.runId, ownerId, state.scope);
    } catch {
      // The foreground release remains authoritative; late monitor cleanup is best effort.
    }
  };
  const monitorLease = async () => {
    const now = Date.now();
    try {
      if (now - lastHeartbeat >= heartbeatMs) {
        const renewed = await store.renewLease?.(state.runId, { ownerId, ttlMs }, state.scope);
        if (stopped) {
          await cleanupStoppedMonitorLease();
          return;
        }
        if (!renewed) {
          lost = true;
          controller.abort(new ConflictError(`Agent run "${state.runId}" lost its worker lease.`));
          return;
        }
        lastHeartbeat = now;
      }
      if (now - lastCancellationPoll >= cancellationPollMs) {
        const latest = await store.load(state.runId, state.scope);
        if (stopped) return;
        lastCancellationPoll = now;
        if (latest?.status === "cancel_requested" || latest?.status === "cancelled") {
          cancelled = normalizeAgentRunState(latest);
          controller.abort(new Error(latest.cancellationReason ?? "Agent run was cancelled."));
        }
      }
    } catch (error) {
      if (stopped) {
        await cleanupStoppedMonitorLease();
        return;
      }
      lost = true;
      controller.abort(error);
    }
  };
  const timer = setInterval(() => {
    if (stopped || activeMonitor) return;
    activeMonitor = monitorLease().finally(() => {
      activeMonitor = undefined;
    });
  }, intervalMs);
  timer.unref?.();

  return {
    supported: true,
    signal: controller.signal,
    cancelledState: () => cancelled,
    leaseLost: () => lost,
    release: async () => {
      stopped = true;
      clearInterval(timer);
      const monitor = activeMonitor;
      if (monitor) {
        await waitForAgentMonitorShutdown(monitor, monitorShutdownTimeoutMs);
      }
      await store.releaseLease?.(state.runId, ownerId, state.scope);
    }
  };
};
