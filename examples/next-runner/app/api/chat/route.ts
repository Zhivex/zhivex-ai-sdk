import {
  MAX_MESSAGE_CHARS,
  MAX_SESSION_ID_CHARS,
  noStoreHeaders,
  optionalBoundedString,
  readChatJson,
  safeChatErrorResponse
} from "../../../lib/http";
import { getRunner, resolveCurrentUserId } from "../../../lib/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readChatJson(request);
    const message = optionalBoundedString(body.message, "message", MAX_MESSAGE_CHARS);
    if (!message) {
      return Response.json({ error: "Missing message." }, { status: 400, headers: noStoreHeaders });
    }

    const result = await getRunner().run({
      userId: await resolveCurrentUserId(request),
      sessionId: optionalBoundedString(body.sessionId, "sessionId", MAX_SESSION_ID_CHARS),
      prompt: message,
      abortSignal: request.signal
    });

    return Response.json(
      {
        sessionId: result.session.sessionId,
        status: result.output.status,
        text: result.output.outputText
      },
      { headers: noStoreHeaders }
    );
  } catch (error) {
    return safeChatErrorResponse(error, request);
  }
}
