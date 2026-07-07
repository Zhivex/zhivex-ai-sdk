import { Agent, createFileSessionService, createRunner } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

export const runtime = "nodejs";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const agent = new Agent({
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

type ChatStreamEvent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "finish";
      sessionId: string;
      status: string;
    }
  | {
      type: "error";
      error: string;
    };

const encodeEvent = (event: ChatStreamEvent): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(event)}\n`);

export async function POST(request: Request) {
  const body = (await request.json()) as {
    message?: string;
    sessionId?: string;
  };

  if (!body.message) {
    return Response.json({ error: "Missing message." }, { status: 400 });
  }

  const stream = runner.stream({
    userId: "demo-user",
    sessionId: body.sessionId,
    prompt: body.message
  });

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for await (const text of stream.textStream) {
            controller.enqueue(encodeEvent({ type: "text", text }));
          }

          const result = await stream.collect();
          controller.enqueue(
            encodeEvent({
              type: "finish",
              sessionId: result.session.sessionId,
              status: result.output.status
            })
          );
        } catch (error) {
          controller.enqueue(
            encodeEvent({
              type: "error",
              error: error instanceof Error ? error.message : String(error)
            })
          );
        } finally {
          controller.close();
        }
      }
    }),
    {
      headers: {
        "cache-control": "no-cache",
        "content-type": "application/x-ndjson; charset=utf-8"
      }
    }
  );
}
