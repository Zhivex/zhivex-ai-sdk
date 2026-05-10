import { describe, expect, it } from "vitest";

import * as agents from "../src/index.js";

describe("agents package public surface", () => {
  it("exports the agent runtime facade from core", () => {
    expect(agents.createAgent).toBeTypeOf("function");
    expect(agents.runAgent).toBeTypeOf("function");
    expect(agents.resumeAgent).toBeTypeOf("function");
    expect(agents.streamAgent).toBeTypeOf("function");
    expect(agents.runAgentGroup).toBeTypeOf("function");
    expect(agents.createAgentHandoff).toBeTypeOf("function");
    expect(agents.runAgentHandoff).toBeTypeOf("function");
    expect(agents.createSubAgentTool).toBeTypeOf("function");
    expect(agents.prepareSubagentsForAgent).toBeTypeOf("function");
  });

  it("exports production agent stores, policy, tracing, and evaluation helpers", () => {
    expect(agents.createInMemoryAgentRunStore).toBeTypeOf("function");
    expect(agents.createFileAgentRunStore).toBeTypeOf("function");
    expect(agents.createSqliteAgentRunStore).toBeTypeOf("function");
    expect(agents.createPostgresAgentRunStore).toBeTypeOf("function");
    expect(agents.createInMemoryAgentMemoryStore).toBeTypeOf("function");
    expect(agents.createFileAgentMemoryStore).toBeTypeOf("function");
    expect(agents.createSqliteAgentMemoryStore).toBeTypeOf("function");
    expect(agents.createPostgresAgentMemoryStore).toBeTypeOf("function");
    expect(agents.createProductionSafetyPolicy).toBeTypeOf("function");
    expect(agents.createAgentTraceCollector).toBeTypeOf("function");
    expect(agents.createAgentEvaluationFixture).toBeTypeOf("function");
  });

  it("exports provider support helpers for agent routing decisions", () => {
    expect(agents.getAgentCapabilities).toBeTypeOf("function");
    expect(agents.getAgentSupportTier).toBeTypeOf("function");
    expect(agents.inspectProviderAgentSupport).toBeTypeOf("function");
    expect(agents.createProviderSupportMatrix).toBeTypeOf("function");
    expect(agents.renderProviderSupportMatrix).toBeTypeOf("function");
  });

  it("does not expose obsolete standalone agent package contracts", () => {
    expect("createAgentRegistry" in agents).toBe(false);
    expect("createInMemoryCheckpointStore" in agents).toBe(false);
    expect("delegateToAgent" in agents).toBe(false);
    expect("handoffToAgent" in agents).toBe(false);
  });

  it("does not expose broad non-agent runtime helpers", () => {
    expect("generateText" in agents).toBe(false);
    expect("generateObject" in agents).toBe(false);
    expect("createWorkflow" in agents).toBe(false);
    expect("createFileArtifactService" in agents).toBe(false);
    expect("uploadFile" in agents).toBe(false);
    expect("generateImage" in agents).toBe(false);
  });
});
