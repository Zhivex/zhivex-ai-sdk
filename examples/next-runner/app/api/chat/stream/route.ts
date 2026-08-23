import {
  fromUIMessage,
  toUIRunnerStreamResponse,
  type AgentApprovalResponse
} from "@zhivex-ai/sdk";
import {
  ChatRequestError,
  MAX_APPROVALS,
  MAX_SESSION_ID_CHARS,
  noStoreHeaders,
  optionalBoundedString,
  optionalUserMessage,
  readChatJson,
  safeChatErrorResponse
} from "../../../../lib/http";
import { getRunner, resolveCurrentUserId } from "../../../../lib/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readChatJson(request);
    const message = optionalUserMessage(body.message);
    const approvals = body.approvals as AgentApprovalResponse[] | undefined;
    if (approvals !== undefined && (!Array.isArray(approvals) || approvals.length > MAX_APPROVALS)) {
      throw new ChatRequestError(`approvals must contain at most ${MAX_APPROVALS} items.`);
    }
    if (!message && !approvals?.length) {
      return Response.json(
        { error: "Missing message or approval." },
        { status: 400, headers: noStoreHeaders }
      );
    }

    const stream = getRunner().stream({
      userId: await resolveCurrentUserId(request),
      sessionId: optionalBoundedString(body.sessionId, "sessionId", MAX_SESSION_ID_CHARS),
      messages: message ? [fromUIMessage(message)] : undefined,
      approvals,
      abortSignal: request.signal
    });

    return toUIRunnerStreamResponse(stream, { headers: noStoreHeaders });
  } catch (error) {
    return safeChatErrorResponse(error, request);
  }
}
