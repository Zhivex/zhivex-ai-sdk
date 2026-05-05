import { createAgent, createFileSessionService, createRunner } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

export const runtime = "nodejs";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const agent = createAgent({
  model: openai("gpt-4o-mini"),
  instructions: "You are a concise support assistant."
});

const runner = createRunner({
  appName: "next-runner-example",
  agent,
  sessionService: createFileSessionService({
    directory: ".zhivex/sessions"
  })
});

export async function POST(request: Request) {
  const body = (await request.json()) as {
    message?: string;
    sessionId?: string;
  };

  if (!body.message) {
    return Response.json({ error: "Missing message." }, { status: 400 });
  }

  const userId = "demo-user";

  const result = await runner.run({
    userId,
    sessionId: body.sessionId,
    prompt: body.message
  });

  return Response.json({
    sessionId: result.session.sessionId,
    status: result.output.status,
    text: result.output.outputText
  });
}
