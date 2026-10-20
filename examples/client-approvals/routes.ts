import {
  createAgent,
  createAgentControlPlane,
  createInMemoryAgentRunStore,
  createMockLanguageModel,
  createTextMessage,
  streamObject,
  toSSEResponse,
  tool,
  type AgentControlPlane,
  type AgentStreamEvent
} from "@zhivex-ai/core";
import {
  collectAgUiEvents,
  createClientApprovalSession,
  handleClientApprovalDecision,
  type ClientApprovalSession
} from "@zhivex-ai/ag-ui";
import { z } from "zod";

const triageSchema = z.object({
  priority: z.enum(["low", "medium", "high"]),
  team: z.string(),
  summary: z.string()
});

interface DemoRun {
  controlPlane: AgentControlPlane;
  session: ClientApprovalSession;
}

const runs = new Map<string, DemoRun>();

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

const createDeployRun = (): DemoRun => {
  const store = createInMemoryAgentRunStore();
  const agent = createAgent({
    id: "deploy-demo",
    store,
    maxSteps: 3,
    model: createMockLanguageModel({
      provider: "mock",
      modelId: "mock-model",
      capabilities: { tools: true, streaming: true },
      // stream() reads streamEvents. resumeApproval() calls generate(), which reads responses.
      responses: [
        {
          messages: [createTextMessage("assistant", "deployed")],
          text: "deployed",
          finishReason: "stop"
        }
      ],
      streamEvents: [[
        { type: "text-delta", textDelta: "Need approval to deploy." },
        {
          type: "tool-call",
          toolCall: { id: "deploy-call-1", name: "deploy", input: { target: "staging" } }
        },
        { type: "finish", finishReason: "tool-calls" }
      ]]
    }),
    tools: {
      deploy: tool({
        name: "deploy",
        description: "Deploy the service to an environment.",
        schema: z.object({ target: z.string() }),
        requiresApproval: true,
        approvalMode: "interrupt",
        approvalVersion: "1",
        execute: () => ({ deployed: true })
      })
    }
  });
  const controlPlane = createAgentControlPlane({ agent });
  return { controlPlane, session: createClientApprovalSession({ controlPlane }) };
};

const readPrompt = async (request: Request, fallback: string): Promise<string> => {
  try {
    const body = await request.json() as { prompt?: unknown };
    return typeof body.prompt === "string" && body.prompt.length > 0 ? body.prompt : fallback;
  } catch {
    return fallback;
  }
};

const streamAgentRoute = async (prompt: string): Promise<Response> => {
  const demo = createDeployRun();
  const stream = demo.controlPlane.stream({ prompt });
  const sdkEvents: AgentStreamEvent[] = [];
  const reading = (async () => {
    for await (const event of stream.eventStream) sdkEvents.push(event);
  })();
  const output = await stream.collect();
  await reading;
  if (!("state" in output)) {
    throw new Error("This example does not attach a runner session.");
  }
  const runId = output.state.runId;
  runs.set(runId, demo);
  const agui = await collectAgUiEvents(sdkEvents, {
    threadId: "demo",
    runId,
    now: () => Date.now()
  });
  const pauses = output.state.status === "waiting_approval"
    ? demo.session.publish(output.state, { expiresAt: Date.now() + 15 * 60 * 1000 })
    : [];
  return toSSEResponse((async function* () {
    yield* agui;
    yield* pauses;
  })(), {
    event: (event) => event.type
  });
};

const objectRoute = async (prompt: string): Promise<Response> => {
  const result = streamObject({
    model: createMockLanguageModel({
      provider: "mock",
      modelId: "mock-model",
      capabilities: { structuredOutput: true, streaming: true },
      streamEvents: [[
        { type: "text-delta", textDelta: "{\"priority\":\"high\",\"team\":\"ops\"," },
        { type: "text-delta", textDelta: "\"summary\":\"disk full\"}" },
        { type: "finish", finishReason: "stop" }
      ]]
    }),
    schema: triageSchema,
    prompt,
    mode: "native"
  });
  return toSSEResponse(result.eventStream, { event: (event) => event.type });
};

/** Mock-provider routes. No live provider calls. */
export const handleDemoRequest = async (request: Request): Promise<Response | undefined> => {
  const url = new URL(request.url);
  if (request.method !== "POST") return undefined;
  if (url.pathname === "/api/agent") {
    return streamAgentRoute(await readPrompt(request, "deploy staging"));
  }
  if (url.pathname === "/api/approvals") {
    const payload = await request.json() as { runId?: unknown };
    const runId = typeof payload.runId === "string" ? payload.runId : "";
    const demo = runs.get(runId);
    if (!demo) return json({ ok: false, code: "forged" }, 403);
    return handleClientApprovalDecision(demo.session, new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }));
  }
  if (url.pathname === "/api/object") {
    return objectRoute(await readPrompt(request, "Triage a disk alert."));
  }
  return undefined;
};
