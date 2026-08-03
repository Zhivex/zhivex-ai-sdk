import { describe, expect, it } from "vitest";

import {
  WORKFLOW_RUN_STATE_SCHEMA_VERSION,
  createAgent,
  createInMemorySessionService,
  createRunner,
  createWorkflow,
  runWorkflow
} from "../src/index.js";
import { integrationLanguageProviders } from "./integration-registry.js";

const workflowProviders = integrationLanguageProviders.filter((provider) =>
  provider.name === "gemini" || provider.name === "qwen"
);
const describeProviderWorkflows = workflowProviders.length
  ? (describe.sequential ?? describe.skip)
  : describe.skip;

describeProviderWorkflows("live provider workflow integration", () => {
  for (const provider of workflowProviders) {
    it(`${provider.name} completes a persisted two-step workflow`, async () => {
      const firstMarker = `integration-${provider.name}-workflow-first-ok`;
      const secondMarker = `integration-${provider.name}-workflow-second-ok`;
      const sessionService = createInMemorySessionService();
      const runner = createRunner({
        appName: `live-workflow-${provider.name}`,
        agent: createAgent({ model: provider.createModel(), maxSteps: 1 }),
        sessionService,
        defaults: {
          maxTokens: provider.textMaxTokens ?? 128,
          ...(provider.omitTemperature ? {} : { temperature: provider.temperature ?? 0 })
        }
      });
      const workflow = createWorkflow({
        id: `live-${provider.name}-workflow`,
        persistence: {
          appName: `live-workflow-${provider.name}`,
          sessionService
        },
        steps: [
          {
            id: "first",
            runner,
            prompt: `Reply with exactly: ${firstMarker}`,
            outputKey: "first"
          },
          {
            id: "second",
            runner,
            prompt: ({ outputs }) =>
              `The previous workflow output was ${String(outputs.first)}. Reply with exactly: ${secondMarker}`,
            outputKey: "second"
          }
        ]
      });

      const result = await runWorkflow(workflow, {
        userId: `live-workflow-${provider.name}`,
        sessionId: `live-workflow-${provider.name}-${Date.now()}`
      });

      expect(result.status, JSON.stringify(result.steps)).toBe("completed");
      expect(result.state.schemaVersion).toBe(WORKFLOW_RUN_STATE_SCHEMA_VERSION);
      expect(String(result.outputs.first).toLowerCase()).toContain(firstMarker);
      expect(String(result.outputs.second).toLowerCase()).toContain(secondMarker);
      expect(result.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
    }, 120_000);
  }
});
