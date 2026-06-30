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
    expect(api.listApiStability("beta")).toContainEqual({
      symbol: "createAgentControlPlane",
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

    expect(api.getApiStability("createRunner")?.stability).toBe("stable");
    expect(api.getApiStability("createProductionSafetyPolicy")?.stability).toBe("stable");
    expect(api.getApiStability("createProductionTraceCollector")?.stability).toBe("stable");
    expect(api.getApiStability("createProductionTraceOptions")?.stability).toBe("stable");
    expect(api.getApiStability("chunkText")?.stability).toBe("stable");
    expect(api.getApiStability("embedRetrievalDocuments")?.stability).toBe("stable");
    expect(api.getApiStability("retrieveContext")?.stability).toBe("stable");
    expect(api.getApiStability("createInMemorySessionService")?.stability).toBe("stable");
    expect(api.getApiStability("createFileSessionService")?.stability).toBe("stable");
    expect(api.getApiStability("createWorkflow")?.stability).toBe("beta");
    expect(api.getApiStability("createFileArtifactService")?.stability).toBe("beta");
    expect(api.getApiStability("createFileWorkflowStateService")?.stability).toBe("beta");
    expect(api.getApiStability("verifyArtifactIntegrity")?.stability).toBe("beta");
    expect(api.getApiStability("createAgentAuditRecord")?.stability).toBe("beta");
    expect(api.getApiStability("createToolAuditRecords")?.stability).toBe("beta");
    expect(api.getApiStability("createReadOnlyToolApprovalPolicy")?.stability).toBe("beta");
    expect(api.getApiStability("createAgentControlPlane")?.stability).toBe("beta");
    expect(api.getApiStability("createAgentCapsule")?.stability).toBe("beta");
    expect(api.getApiStability("createAgentRunLedger")?.stability).toBe("beta");
    expect(api.getApiStability("selectAgentModel")?.stability).toBe("beta");

    expect(api.getApiStability("createAdvancedToolRegistry")?.stability).toBe("experimental");
    expect(api.getApiStability("missingSymbol")).toBeUndefined();
  });
});
