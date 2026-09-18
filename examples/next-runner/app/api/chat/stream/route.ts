import { ChatReplayError, InMemoryChatReplayStore } from "@zhivex-ai/react/replay";
import { parseChatEventStream } from "@zhivex-ai/react/transport";
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

// Single-process example. Use a shared replay service for multiple workers or serverless.
const replay = new InMemoryChatReplayStore();

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    return replay.response({
      streamId: url.searchParams.get("streamId") ?? "",
      after: Number(url.searchParams.get("after") ?? "0"),
      ownerId: await resolveCurrentUserId(request), signal: request.signal
    });
  } catch (error) {
    if (error instanceof ChatReplayError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    return safeChatErrorResponse(error, request);
  }
}

export async function DELETE(request: Request) {
  try {
    replay.cancel(new URL(request.url).searchParams.get("streamId") ?? "", await resolveCurrentUserId(request));
    return new Response(null, { status: 204, headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof ChatReplayError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    return safeChatErrorResponse(error, request);
  }
}

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

    if (new URL(request.url).searchParams.get("replay") === "1") {
      const ownerId = await resolveCurrentUserId(request);
      const sessionId = optionalBoundedString(body.sessionId, "sessionId", MAX_SESSION_ID_CHARS);
      const streamId = replay.create({ ownerId, source: async function* (signal) {
        const stream = getRunner().stream({ userId: ownerId, sessionId,
          messages: message ? [fromUIMessage(message)] : undefined, approvals, abortSignal: signal });
        const response = toUIRunnerStreamResponse(stream);
        yield* parseChatEventStream(response.body!, { idleTimeoutMs: false });
      } });
      return replay.response({ streamId, ownerId, signal: request.signal });
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
    if (error instanceof ChatReplayError) return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    return safeChatErrorResponse(error, request);
  }
}
