import { describe, expect, it } from "vitest";

import * as api from "../src/index.js";

describe("api stability manifest", () => {
  it("classifies every runtime export from core", () => {
    expect(Object.keys(api.API_STABILITY_MANIFEST).sort()).toEqual(Object.keys(api).sort());
  });

  it("lists entries by stability level", () => {
    expect(api.listApiStability("stable")).toContainEqual({
      symbol: "generateText",
      stability: "stable"
    });
    expect(api.listApiStability("stable")).toContainEqual({
      symbol: "createRunner",
      stability: "stable"
    });
    expect(api.listApiStability("experimental")).toContainEqual({
      symbol: "createAdvancedToolRegistry",
      stability: "experimental"
    });
  });

  it("keeps the RC boundary classifications explicit", () => {
    expect(api.getApiStability("generateText")?.stability).toBe("stable");
    expect(api.getApiStability("runAgent")?.stability).toBe("stable");
    expect(api.getApiStability("createAgent")?.stability).toBe("stable");

    expect(api.getApiStability("createRunner")?.stability).toBe("stable");
    expect(api.getApiStability("createInMemorySessionService")?.stability).toBe("stable");
    expect(api.getApiStability("createFileSessionService")?.stability).toBe("stable");
    expect(api.getApiStability("createWorkflow")?.stability).toBe("beta");
    expect(api.getApiStability("createFileArtifactService")?.stability).toBe("beta");
    expect(api.getApiStability("createFileWorkflowStateService")?.stability).toBe("beta");
    expect(api.getApiStability("verifyArtifactIntegrity")?.stability).toBe("beta");

    expect(api.getApiStability("createAdvancedToolRegistry")?.stability).toBe("experimental");
    expect(api.getApiStability("missingSymbol")).toBeUndefined();
  });
});
