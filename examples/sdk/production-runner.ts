import {
  applySafetyPolicyToAgent,
  createAgent,
  createPostgresSessionService,
  createProductionSafetyPolicy,
  createRunner,
  type PostgresClientLike
} from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

/**
 * Production template.
 *
 * This file is intentionally not directly runnable: your application owns the
 * Postgres driver/client, auth, tenancy, billing, rate limits, and model
 * selection. The SDK only needs a Postgres-compatible `query(sql, params)`
 * client, so no database driver is imported here.
 */

declare const postgresClient: PostgresClientLike;
declare function resolveCurrentUserId(request: Request): Promise<string>;

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const baseAgent = createAgent({
  id: "production-support-agent",
  model: openai("gpt-4o-mini"),
  instructions: "You are a concise support assistant. Ask for clarification when user context is missing.",
  maxSteps: 6
});

const agent = applySafetyPolicyToAgent(
  baseAgent,
  createProductionSafetyPolicy()
);

const sessionService = createPostgresSessionService({
  client: postgresClient,
  tableName: "zhivex_agent_sessions"
});

const runner = createRunner({
  appName: "support-api",
  agent,
  sessionService
});

export async function handleChatRequest(request: Request): Promise<Response> {
  const body = (await request.json()) as {
    message?: string;
    sessionId?: string;
  };

  if (!body.message?.trim()) {
    return Response.json({ error: "Missing message." }, { status: 400 });
  }

  const userId = await resolveCurrentUserId(request);
  const result = await runner.run({
    userId,
    sessionId: body.sessionId,
    prompt: body.message,
    eventMetadata: {
      route: "POST /api/chat"
    }
  });

  return Response.json({
    sessionId: result.session.sessionId,
    status: result.output.status,
    text: result.output.outputText
  });
}
