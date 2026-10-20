import { ClientApprovalError, type ClientApprovalDecision, type ClientApprovalSession } from "./approval.js";

const MAX_ID_CHARS = 512;
const MAX_TOKEN_CHARS = 8_192;
const MAX_REASON_CHARS = 1_000;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

const statusFor = (error: ClientApprovalError): number => {
  if (error.code === "invalid") return 400;
  if (error.code === "replayed") return 409;
  if (error.code === "stale") return 410;
  return 403;
};

const readString = (value: unknown, name: string, maxChars: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    throw new ClientApprovalError("invalid", `Approval decision field "${name}" is invalid.`);
  }
  return value;
};

/** Reads a decision from JSON. Extra fields, including a queue item, are ignored. */
export const parseClientApprovalDecision = (value: unknown): ClientApprovalDecision => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClientApprovalError("invalid", "Approval decision must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const reason = record.reason;
  if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_REASON_CHARS)) {
    throw new ClientApprovalError("invalid", 'Approval decision field "reason" is invalid.');
  }
  if (typeof record.approve !== "boolean") {
    throw new ClientApprovalError("invalid", 'Approval decision field "approve" must be a boolean.');
  }
  return {
    runId: readString(record.runId, "runId", MAX_ID_CHARS),
    provider: readString(record.provider, "provider", MAX_ID_CHARS),
    approvalRequestId: readString(record.approvalRequestId, "approvalRequestId", MAX_ID_CHARS),
    approvalToken: readString(record.approvalToken, "approvalToken", MAX_TOKEN_CHARS),
    approve: record.approve,
    ...(typeof reason === "string" ? { reason } : {})
  };
};

/**
 * Accepts a client decision and resumes the matching run.
 * The response is a status summary. It does not include the ledger, token, or queue item.
 */
export const handleClientApprovalDecision = async (
  session: ClientApprovalSession,
  request: Request
): Promise<Response> => {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, code: "invalid" }, 400);
  }
  try {
    const decision = parseClientApprovalDecision(payload);
    const record = await session.decide(decision);
    return json({
      ok: true,
      runId: record.state.runId,
      status: record.state.status,
      outputText: record.state.outputText
    }, 200);
  } catch (error) {
    if (error instanceof ClientApprovalError) {
      return json({ ok: false, code: error.code }, statusFor(error));
    }
    throw error;
  }
};
