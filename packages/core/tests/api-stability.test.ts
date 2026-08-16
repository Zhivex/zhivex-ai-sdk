import { describe, expect, it } from "vitest";

import * as api from "../src/index.js";

describe("api stability manifest", () => {
  it("classifies every runtime export from core", () => {
    expect(Object.keys(api.API_STABILITY_MANIFEST).sort()).toEqual(Object.keys(api).sort());
  });

  it("lists entries by stability level", () => {
    expect(api.listApiStability("stable")).toContainEqual({
      symbol: "Agent",
      stability: "stable"
    });
    expect(api.listApiStability("stable")).toContainEqual({
      symbol: "normalizeAgentRunState",
      stability: "stable"
    });
    expect(api.listApiStability("stable")).toContainEqual({
      symbol: "generateText",
      stability: "stable"
    });
    expect(api.listApiStability("stable")).toContainEqual({
      symbol: "createRunner",
      stability: "stable"
    });
    expect(api.listApiStability("stable")).toContainEqual({
      symbol: "createProductionSafetyPolicy",
      stability: "stable"
    });
    expect(api.listApiStability("beta")).toContainEqual({
      symbol: "createAgentAuditRecord",
      stability: "beta"
    });
    expect(api.listApiStability("stable")).toContainEqual({
      symbol: "createAgentControlPlane",
      stability: "stable"
    });
    expect(api.listApiStability("beta")).toContainEqual({
      symbol: "createAgentHarnessBinding",
      stability: "beta"
    });
    expect(api.listApiStability("stable")).toContainEqual({
      symbol: "chunkText",
      stability: "stable"
    });
    expect(api.listApiStability("experimental")).toContainEqual({
      symbol: "createAdvancedToolRegistry",
      stability: "experimental"
    });
  });

  it("keeps the stable boundary classifications explicit", () => {
    expect(api.getApiStability("Agent")?.stability).toBe("stable");
    expect(api.getApiStability("generateText")?.stability).toBe("stable");
    expect(api.getApiStability("runAgent")?.stability).toBe("stable");
    expect(api.getApiStability("createAgent")?.stability).toBe("stable");
    expect(api.getApiStability("AGENT_RUN_STATE_SCHEMA_VERSION")?.stability).toBe("stable");
    expect(api.getApiStability("migrateAgentRunState")?.stability).toBe("stable");
    expect(api.getApiStability("normalizeAgentRunState")?.stability).toBe("stable");
    expect(api.getApiStability("CallbackRealtimeSession")?.stability).toBe("stable");
    expect(api.getApiStability("encodeAudioFrame")?.stability).toBe("stable");
    expect(api.getApiStability("encodeMediaFrame")?.stability).toBe("stable");
    expect(api.getApiStability("openWebSocketConnection")?.stability).toBe("stable");
    expect(api.getApiStability("streamLiveAgent")?.stability).toBe("stable");
    expect(api.getApiStability("unsupportedBrowserToken")?.stability).toBe("stable");

    expect(api.getApiStability("createRunner")?.stability).toBe("stable");
    expect(api.getApiStability("toUIRunnerStreamResponse")?.stability).toBe("stable");
    expect(api.getApiStability("createProductionSafetyPolicy")?.stability).toBe("stable");
    expect(api.getApiStability("createProductionTraceCollector")?.stability).toBe("stable");
    expect(api.getApiStability("createProductionTraceOptions")?.stability).toBe("stable");
    expect(api.getApiStability("chunkText")?.stability).toBe("stable");
    expect(api.getApiStability("embedRetrievalDocuments")?.stability).toBe("stable");
    expect(api.getApiStability("retrieveContext")?.stability).toBe("stable");
    expect(api.getApiStability("createInMemorySessionService")?.stability).toBe("stable");
    expect(api.getApiStability("createFileSessionService")?.stability).toBe("stable");
    expect(api.getApiStability("createWorkflow")?.stability).toBe("stable");
    expect(api.getApiStability("runWorkflow")?.stability).toBe("stable");
    expect(api.getApiStability("replayWorkflowRun")?.stability).toBe("stable");
    expect(api.getApiStability("WORKFLOW_RUN_STATE_SCHEMA_VERSION")?.stability).toBe("stable");
    expect(api.getApiStability("WORKFLOW_STATE_RECORD_SCHEMA_VERSION")?.stability).toBe("stable");
    expect(api.getApiStability("createFileArtifactService")?.stability).toBe("stable");
    expect(api.getApiStability("createFileWorkflowStateService")?.stability).toBe("stable");
    expect(api.getApiStability("createInMemoryWorkflowStateService")?.stability).toBe("stable");
    expect(api.getApiStability("createPostgresWorkflowStateService")?.stability).toBe("stable");
    expect(api.getApiStability("createSqliteWorkflowStateService")?.stability).toBe("stable");
    expect(api.getApiStability("createWorkflowEvaluationFixture")?.stability).toBe("stable");
    expect(api.getApiStability("createWorkflowEvaluationBaseline")?.stability).toBe("stable");
    expect(api.getApiStability("evaluateWorkflowEvaluationGate")?.stability).toBe("stable");
    expect(api.getApiStability("verifyArtifactIntegrity")?.stability).toBe("stable");
    expect(api.getApiStability("createModelCatalog")?.stability).toBe("stable");
    expect(api.getApiStability("createOtelObserver")?.stability).toBe("stable");
    expect(api.getApiStability("createOtelWorkflowObserver")?.stability).toBe("stable");
    expect(api.getApiStability("OTEL_GENAI_CONTRACT_VERSION")?.stability).toBe("stable");
    expect(api.getApiStability("OTEL_GENAI_SEMCONV_REVISION")?.stability).toBe("stable");
    expect(api.getApiStability("createAgentAuditRecord")?.stability).toBe("beta");
    expect(api.getApiStability("createToolAuditRecords")?.stability).toBe("beta");
    expect(api.getApiStability("createReadOnlyToolApprovalPolicy")?.stability).toBe("beta");
    expect(api.getApiStability("createAgentControlPlane")?.stability).toBe("stable");
    expect(api.getApiStability("createAgentCapsule")?.stability).toBe("stable");
    expect(api.getApiStability("createAgentExecutionEnvironmentBinding")?.stability).toBe("beta");
    expect(api.getApiStability("createAgentHarnessBinding")?.stability).toBe("beta");
    expect(api.getApiStability("fingerprintAgentHarness")?.stability).toBe("beta");
    expect(api.getApiStability("createAgentRunLedger")?.stability).toBe("stable");
    expect(api.getApiStability("normalizeAgentRunLedger")?.stability).toBe("stable");
    expect(api.getApiStability("migrateAgentApprovalQueueItem")?.stability).toBe("stable");
    expect(api.getApiStability("selectAgentModel")?.stability).toBe("stable");

    expect(api.getApiStability("createAdvancedToolRegistry")?.stability).toBe("experimental");
    expect(api.getApiStability("missingSymbol")).toBeUndefined();
  });
});
