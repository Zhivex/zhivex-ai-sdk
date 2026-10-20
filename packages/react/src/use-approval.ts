"use client";

import { useCallback, useRef, useState } from "react";

/** Wire format emitted by @zhivex-ai/ag-ui after a governance pause. */
export interface ApprovalPause {
  type: "zhivex.approval.pause";
  runId: string;
  provider: string;
  approvalRequestId: string;
  name: string;
  approvalToken: string;
  kind?: string;
  toolCallId?: string;
  expiresAt?: string;
  arguments?: string;
}

export interface ApprovalDecisionResult {
  ok: boolean;
  code?: string;
  runId?: string;
  status?: string;
  outputText?: string;
}

export interface UseApprovalOptions {
  /** Endpoint that verifies the decision and resumes the run. Defaults to /api/approvals. */
  api?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
  onDecision?: (result: ApprovalDecisionResult) => void;
  onError?: (error: Error) => void;
}

export interface UseApprovalResult {
  pending: ApprovalPause[];
  submitting: boolean;
  error?: Error;
  lastResult?: ApprovalDecisionResult;
  receive: (pause: ApprovalPause) => void;
  /** Accepts a pause event or an AG-UI RUN_FINISHED interrupt that carries a token. */
  receiveEvent: (event: unknown) => void;
  approve: (approvalRequestId: string, reason?: string, provider?: string) => Promise<void>;
  reject: (approvalRequestId: string, reason?: string, provider?: string) => Promise<void>;
  clear: () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export const isApprovalPause = (value: unknown): value is ApprovalPause =>
  isRecord(value) &&
  value.type === "zhivex.approval.pause" &&
  isString(value.runId) &&
  isString(value.provider) &&
  isString(value.approvalRequestId) &&
  isString(value.name) &&
  isString(value.approvalToken);

const pauseKey = (pause: Pick<ApprovalPause, "provider" | "approvalRequestId">) =>
  `${pause.provider}\0${pause.approvalRequestId}`;

const pausesFromEvent = (event: unknown): ApprovalPause[] => {
  if (isApprovalPause(event)) return [event];
  if (!isRecord(event) || event.type !== "RUN_FINISHED" || !isRecord(event.outcome)) return [];
  if (event.outcome.type !== "interrupt" || !Array.isArray(event.outcome.interrupts)) return [];
  if (!isString(event.runId)) return [];
  const pauses: ApprovalPause[] = [];
  for (const interrupt of event.outcome.interrupts) {
    if (!isRecord(interrupt) || !isRecord(interrupt.metadata)) continue;
    const metadata = interrupt.metadata;
    if (!isString(metadata.approvalToken) || !isString(metadata.provider) || !isString(metadata.approvalRequestId)) {
      continue;
    }
    pauses.push({
      type: "zhivex.approval.pause",
      runId: event.runId,
      provider: metadata.provider,
      approvalRequestId: metadata.approvalRequestId,
      name: isString(metadata.name) ? metadata.name : metadata.approvalRequestId,
      approvalToken: metadata.approvalToken,
      ...(isString(metadata.kind) ? { kind: metadata.kind } : {}),
      ...(isString(interrupt.toolCallId) ? { toolCallId: interrupt.toolCallId } : {}),
      ...(isString(interrupt.expiresAt) ? { expiresAt: interrupt.expiresAt } : {})
    });
  }
  return pauses;
};

const selectPause = (
  pending: readonly ApprovalPause[],
  approvalRequestId: string,
  provider?: string
): ApprovalPause => {
  const matches = pending.filter(
    (pause) =>
      pause.approvalRequestId === approvalRequestId &&
      (provider === undefined || pause.provider === provider)
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Unknown approval request "${approvalRequestId}".`
        : `Approval request "${approvalRequestId}" is ambiguous; provide its provider.`
    );
  }
  return matches[0]!;
};

/**
 * Tracks governance approval pauses and posts the decision to the server.
 * The server must verify the token against that run before resuming.
 */
export const useApproval = (options: UseApprovalOptions = {}): UseApprovalResult => {
  const [pending, setPending] = useState<ApprovalPause[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [lastResult, setLastResult] = useState<ApprovalDecisionResult | undefined>();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const receive = useCallback((pause: ApprovalPause) => {
    if (!isApprovalPause(pause)) return;
    setPending((current) => {
      const key = pauseKey(pause);
      const index = current.findIndex((item) => pauseKey(item) === key);
      if (index === -1) return [...current, pause];
      const next = [...current];
      next[index] = pause;
      return next;
    });
    setError(undefined);
  }, []);

  const receiveEvent = useCallback((event: unknown) => {
    for (const pause of pausesFromEvent(event)) receive(pause);
  }, [receive]);

  const clear = useCallback(() => {
    setPending([]);
    setError(undefined);
    setLastResult(undefined);
    setSubmitting(false);
  }, []);

  const decide = useCallback(async (
    approvalRequestId: string,
    approve: boolean,
    reason?: string,
    provider?: string
  ) => {
    const pause = selectPause(pendingRef.current, approvalRequestId, provider);
    const current = optionsRef.current;
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await (current.fetch ?? globalThis.fetch)(current.api ?? "/api/approvals", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(current.headers ?? {})
        },
        body: JSON.stringify({
          runId: pause.runId,
          provider: pause.provider,
          approvalRequestId: pause.approvalRequestId,
          approvalToken: pause.approvalToken,
          approve,
          ...(reason !== undefined ? { reason } : {})
        })
      });
      let payload: ApprovalDecisionResult = { ok: response.ok };
      try {
        const parsed = await response.json() as unknown;
        if (isRecord(parsed)) {
          payload = {
            ok: parsed.ok === true,
            ...(isString(parsed.code) ? { code: parsed.code } : {}),
            ...(isString(parsed.runId) ? { runId: parsed.runId } : {}),
            ...(isString(parsed.status) ? { status: parsed.status } : {}),
            ...(typeof parsed.outputText === "string" ? { outputText: parsed.outputText } : {})
          };
        }
      } catch {
        payload = { ok: false, code: "invalid" };
      }
      if (!response.ok || payload.ok !== true) {
        const failure = new Error(`Approval decision was rejected${payload.code ? ` (${payload.code})` : ""}.`);
        setError(failure);
        if (payload.code === "replayed" || payload.code === "stale") {
          setPending((items) => items.filter((item) => pauseKey(item) !== pauseKey(pause)));
        }
        current.onError?.(failure);
        return;
      }
      setPending((items) => items.filter((item) => pauseKey(item) !== pauseKey(pause)));
      setLastResult(payload);
      current.onDecision?.(payload);
    } catch (caught) {
      const failure = caught instanceof Error ? caught : new Error(String(caught));
      setError(failure);
      current.onError?.(failure);
    } finally {
      setSubmitting(false);
    }
  }, []);

  const approve = useCallback(
    (approvalRequestId: string, reason?: string, provider?: string) =>
      decide(approvalRequestId, true, reason, provider),
    [decide]
  );
  const reject = useCallback(
    (approvalRequestId: string, reason?: string, provider?: string) =>
      decide(approvalRequestId, false, reason, provider),
    [decide]
  );

  return {
    pending,
    submitting,
    error,
    lastResult,
    receive,
    receiveEvent,
    approve,
    reject,
    clear
  };
};
