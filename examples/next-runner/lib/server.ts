import {
  Agent,
  createFileSessionService,
  createRunner,
  type Runner
} from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

export class StarterConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarterConfigurationError";
  }
}

let runner: Runner | undefined;

export const getRunner = (): Runner => {
  if (runner) {
    return runner;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new StarterConfigurationError("OPENAI_API_KEY is not configured on the server.");
  }

  const openai = createOpenAI({ apiKey });
  runner = createRunner({
    appName: "next-runner-example",
    agent: new Agent({
      model: openai("gpt-4o-mini"),
      instructions: "You are a concise support assistant.",
      maxSteps: 4,
      maxTokens: 512,
      policy: {
        timeoutMs: 60_000,
        onTimeout: "cancel-requested",
        budget: {
          maxSteps: 4,
          maxToolCalls: 4,
          maxOutputTokens: 2_048,
          maxTotalTokens: 8_192
        }
      }
    }),
    sessionService: createFileSessionService({
      directory: ".zhivex/sessions"
    })
  });

  return runner;
};

export const resolveCurrentUserId = async (_request: Request): Promise<string> => {
  if (process.env.NODE_ENV === "production") {
    throw new StarterConfigurationError(
      "Replace resolveCurrentUserId() with authenticated, tenant-scoped application identity before production."
    );
  }

  return "local-demo-user";
};
