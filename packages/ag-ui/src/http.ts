import { ClientApprovalError, type ClientApprovalDecision, type ClientApprovalSession } from "./approval.js";

const MAX_DECISION_BODY_BYTES = 32 * 1024;
const MAX_ID_CHARS = 512;
const MAX_TOKEN_CHARS = 8_192;
const MAX_REASON_CHARS = 1_000;

class DecisionBodyTooLargeError extends Error {}

const readBoundedJsonBody = async (request: Request, maxBytes: number): Promise<unknown> => {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const trimmed = contentLength.trim();
    if (/^\d+$/.test(trimmed) && Number(trimmed) > maxBytes) {
      throw new DecisionBodyTooLargeError("Approval decision request body exceeds limit.");
    }
  }
  if (!request.body) {
    throw new SyntaxError("Approval decision request body is empty.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        chunks.length = 0;
        await reader.cancel().catch(() => undefined);
        throw new DecisionBodyTooLargeError("Approval decision request body exceeds limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
};

const isJsonContentType = (header: string | null): boolean => {
  if (header === null || header.trim() === "") return true;
  const mediaType = header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || /^application\/[\w.+-]+\+json$/.test(mediaType);
};

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
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return json({ ok: false, code: "invalid" }, 400);
  }
  let payload: unknown;
  try {
    payload = await readBoundedJsonBody(request, MAX_DECISION_BODY_BYTES);
  } catch (error) {
    if (error instanceof DecisionBodyTooLargeError) {
      return json({ ok: false, code: "invalid" }, 413);
    }
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
