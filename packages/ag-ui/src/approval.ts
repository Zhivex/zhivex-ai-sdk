import {
  createAgentApprovalQueue,
  type AgentApprovalQueueItem,
  type AgentApprovalQueueOptions,
  type AgentControlPlane,
  type AgentControlPlaneRunRecord,
  type AgentRunState,
  type AgentStoreScope
} from "@zhivex-ai/core";

/**
 * Browser-visible approval pause. The bearer token is the only secret.
 * Queue items, raw provider payloads, and signatures stay on the server.
 */
export interface ClientApprovalPause {
  type: "zhivex.approval.pause";
  runId: string;
  provider: string;
  approvalRequestId: string;
  name: string;
  approvalToken: string;
  kind: NonNullable<AgentApprovalQueueItem["kind"]>;
  toolCallId?: string;
  expiresAt?: string;
  arguments?: string;
}

export interface ClientApprovalDecision {
  runId: string;
  provider: string;
  approvalRequestId: string;
  approvalToken: string;
  approve: boolean;
  reason?: string;
}

export interface ClientApprovalResumeOptions {
  scope?: AgentStoreScope;
  now?: number;
}

export type ClientApprovalErrorCode = "invalid" | "forged" | "replayed" | "stale" | "cross_run";

export class ClientApprovalError extends Error {
  readonly code: ClientApprovalErrorCode;

  constructor(code: ClientApprovalErrorCode, message: string) {
    super(message);
    this.name = "ClientApprovalError";
    this.code = code;
  }
}

interface StoredApproval {
  queueItem: AgentApprovalQueueItem;
  toolCallId?: string;
  consumed: boolean;
  superseded: boolean;
}

export interface ClientApprovalSession {
  /** Mints queue tokens for the run's pending approvals and returns client pauses. */
  publish(state: AgentRunState, options?: AgentApprovalQueueOptions): ClientApprovalPause[];
  /**
   * Verifies a client decision against the stored queue item, then resumes
   * through AgentControlPlane.resumeApproval. The ledger is the control plane record.
   */
  decide(
    decision: ClientApprovalDecision,
    options?: ClientApprovalResumeOptions
  ): Promise<AgentControlPlaneRunRecord>;
}

const REASON_MAX_CHARS = 1_000;
const HISTORY_LIMIT = 64;

/** Compares the full strings without Node crypto. Length is not a shortcut. */
const tokensMatch = (expected: string, actual: string): boolean => {
  const length = Math.max(expected.length, actual.length);
  let mismatch = expected.length ^ actual.length;
  for (let index = 0; index < length; index += 1) {
    const expectedCode = index < expected.length ? expected.charCodeAt(index) : 0;
    const actualCode = index < actual.length ? actual.charCodeAt(index) : 0;
    mismatch |= expectedCode ^ actualCode;
  }
  return mismatch === 0;
};

const assertReason = (reason: unknown): void => {
  if (reason === undefined) return;
  if (typeof reason !== "string" || reason.length > REASON_MAX_CHARS) {
    throw new ClientApprovalError("invalid", 'Approval decision field "reason" is invalid.');
  }
};

const approvalKey = (runId: string, provider: string, approvalRequestId: string) =>
  `${runId}\0${provider}\0${approvalRequestId}`;

const isClientApprovalError = (error: unknown): error is ClientApprovalError =>
  error instanceof ClientApprovalError;

const mapResumeError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  if (/no longer pending|already consumed/i.test(message)) {
    throw new ClientApprovalError("replayed", "This approval decision was already used.");
  }
  if (/expired|fingerprint|does not match|no longer matches|was not found/i.test(message)) {
    throw new ClientApprovalError("stale", "This approval is stale and no longer matches the pending action.");
  }
  if (/token is invalid/i.test(message)) {
    throw new ClientApprovalError("forged", "The approval token does not match this pending approval.");
  }
  throw error;
};

const toPause = (
  queueItem: AgentApprovalQueueItem,
  toolCallId: string | undefined,
  includeArguments: boolean
): ClientApprovalPause => ({
  type: "zhivex.approval.pause",
  runId: queueItem.runId,
  provider: queueItem.provider,
  approvalRequestId: queueItem.approvalRequestId,
  name: queueItem.name,
  approvalToken: queueItem.approvalToken,
  kind: queueItem.kind,
  ...(toolCallId ? { toolCallId } : {}),
  ...(queueItem.expiresAt !== undefined ? { expiresAt: new Date(queueItem.expiresAt).toISOString() } : {}),
  ...(includeArguments && queueItem.arguments !== undefined ? { arguments: queueItem.arguments } : {})
});

/**
 * Server-side gate in front of the existing control-plane approval resume.
 * Clients present a decision. They never supply the trusted queue item.
 */
export const createClientApprovalSession = (options: {
  controlPlane: AgentControlPlane;
  now?: () => number;
}): ClientApprovalSession => {
  const current = new Map<string, StoredApproval>();
  const history: StoredApproval[] = [];
  const now = () => options.now?.() ?? Date.now();

  const isExpired = (record: StoredApproval, clock: number): boolean =>
    record.queueItem.expiresAt !== undefined && clock >= record.queueItem.expiresAt;

  const detach = (record: StoredApproval): void => {
    for (const [key, stored] of current) {
      if (stored === record) current.delete(key);
    }
    const index = history.indexOf(record);
    if (index !== -1) history.splice(index, 1);
  };

  const prune = (clock: number): void => {
    for (const [key, record] of [...current.entries()]) {
      if (isExpired(record, clock)) {
        current.delete(key);
        continue;
      }
      if (record.consumed || record.superseded) {
        current.delete(key);
        if (!history.includes(record)) history.push(record);
      }
    }
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const record = history[index];
      if (record && isExpired(record, clock)) history.splice(index, 1);
    }
    while (history.length > HISTORY_LIMIT) history.shift();
  };

  const capHistory = (): void => {
    while (history.length > HISTORY_LIMIT) history.shift();
  };

  const findByToken = (token: string): StoredApproval | undefined => {
    const matches: StoredApproval[] = [];
    for (const record of current.values()) {
      if (tokensMatch(record.queueItem.approvalToken, token)) matches.push(record);
    }
    for (const record of history) {
      if (tokensMatch(record.queueItem.approvalToken, token)) matches.push(record);
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new ClientApprovalError("forged", "The approval token is ambiguous.");
    }
    return undefined;
  };

  return {
    publish(state, queueOptions = {}) {
      prune(now());
      const includeArguments = queueOptions.includeArguments === true;
      const queue = createAgentApprovalQueue(state, queueOptions);
      return queue.map((queueItem) => {
        const pending = state.pendingApprovals.find(
          (approval) =>
            approval.provider === queueItem.provider &&
            approval.id === queueItem.approvalRequestId
        );
        const key = approvalKey(queueItem.runId, queueItem.provider, queueItem.approvalRequestId);
        const previous = current.get(key);
        if (previous && !previous.consumed) {
          previous.superseded = true;
          previous.consumed = true;
          history.push(previous);
          capHistory();
        }
        const stored: StoredApproval = {
          queueItem,
          toolCallId: pending?.toolCallId,
          consumed: false,
          superseded: false
        };
        current.set(key, stored);
        return toPause(queueItem, pending?.toolCallId, includeArguments);
      });
    },

    async decide(decision, resumeOptions = {}) {
      if (!decision || typeof decision !== "object") {
        throw new ClientApprovalError("invalid", "Approval decision must be an object.");
      }
      const runId = decision.runId;
      const provider = decision.provider;
      const approvalRequestId = decision.approvalRequestId;
      const approvalToken = decision.approvalToken;
      if (
        typeof runId !== "string" ||
        typeof provider !== "string" ||
        typeof approvalRequestId !== "string" ||
        typeof approvalToken !== "string" ||
        typeof decision.approve !== "boolean"
      ) {
        throw new ClientApprovalError("invalid", "Approval decision is missing a required field.");
      }
      assertReason(decision.reason);
      const clock = resumeOptions.now ?? now();
      const owner = findByToken(approvalToken);
      if (!owner) {
        prune(clock);
        throw new ClientApprovalError("forged", "The approval token does not match a pending approval.");
      }
      if (
        owner.queueItem.runId !== runId ||
        owner.queueItem.provider !== provider ||
        owner.queueItem.approvalRequestId !== approvalRequestId
      ) {
        throw new ClientApprovalError(
          "cross_run",
          "The approval decision does not belong to this run and pending approval."
        );
      }
      if (owner.superseded) {
        prune(clock);
        throw new ClientApprovalError("stale", "The approval token has been replaced.");
      }
      if (owner.consumed) {
        prune(clock);
        throw new ClientApprovalError("replayed", "This approval decision was already used.");
      }
      if (isExpired(owner, clock)) {
        detach(owner);
        prune(clock);
        throw new ClientApprovalError("stale", "The approval token has expired.");
      }
      prune(clock);
      owner.consumed = true;
      try {
        return await options.controlPlane.resumeApproval({
          ...(resumeOptions.scope ? { scope: resumeOptions.scope } : {}),
          queueItem: owner.queueItem,
          approvalToken: owner.queueItem.approvalToken,
          approve: decision.approve,
          ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
          now: clock
        });
      } catch (error) {
        if (isClientApprovalError(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (!/no longer pending|already consumed|expired|fingerprint|does not match|no longer matches|token is invalid|was not found/i.test(message)) {
          owner.consumed = false;
        }
        throw mapResumeError(error);
      }
    }
  };
};
