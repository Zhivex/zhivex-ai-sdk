import {
  Agent,
  createFileSessionService,
  createRunner,
  fromUIMessage,
  toUIRunnerStreamResponse,
  type AgentApprovalResponse,
  type UIMessage
} from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

export const runtime = "nodejs";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const runner = createRunner({
  appName: "next-runner-example",
  agent: new Agent({
    model: openai("gpt-4o-mini"),
    instructions: "You are a concise support assistant."
  }),
  sessionService: createFileSessionService({
    directory: ".zhivex/sessions"
  })
});

export async function POST(request: Request) {
  const body = (await request.json()) as {
    message?: UIMessage;
    sessionId?: string;
    approvals?: AgentApprovalResponse[];
  };

  if (!body.message && !body.approvals?.length) {
    return Response.json(
      { error: "Missing message or approval." },
      { status: 400 }
    );
  }

  const stream = runner.stream({
    userId: "demo-user",
    sessionId: body.sessionId,
    messages: body.message ? [fromUIMessage(body.message)] : undefined,
    approvals: body.approvals,
    abortSignal: request.signal
  });

  return toUIRunnerStreamResponse(stream);
}
