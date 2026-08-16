import { describe, expect, it } from "vitest";

import * as beta from "../src/beta.js";
import * as controlPlane from "../src/control-plane.js";
import * as agents from "../src/index.js";
import * as ops from "../src/ops.js";
import * as realtime from "../src/realtime.js";
import * as testing from "../src/testing.js";
import { getApiStability, type ApiStabilityLevel } from "../../core/src/api-stability.js";

const sortedKeys = (value: object) => Object.keys(value).sort();
const expectStability = (value: object, stability: ApiStabilityLevel) => {
  for (const symbol of Object.keys(value)) {
    expect(getApiStability(symbol), symbol).toMatchObject({ stability, symbol });
  }
};

describe("agents package public surface", () => {
  it("keeps the root focused on the stable application runtime", () => {
    expect(sortedKeys(agents)).toEqual([
      "AGENT_RUN_STATE_SCHEMA_VERSION",
      "Agent",
      "agentApprovalResponsePart",
      "applySafetyPolicyToAgent",
      "cancelAgentRun",
      "cancelAgentRunTree",
      "createAgent",
      "createAgentApprovalMessage",
      "createAgentHandoff",
      "createAgentHandoffMessage",
      "createApprovalPolicy",
      "createBudgetGuard",
      "createProductionSafetyPolicy",
      "createRedactionPolicy",
      "createSafetyPolicy",
      "createSubAgentTool",
      "evaluateAgentBudgetPreflight",
      "getAgentApprovalRequestFromPart",
      "getAgentApprovalRequests",
      "getAgentBudgetStatus",
      "migrateAgentRunState",
      "normalizeAgentRunState",
      "prepareSubagentsForAgent",
      "resumeAgent",
      "runAgent",
      "runAgentGroup",
      "runAgentHandoff",
      "streamAgent",
      "toUIAgentStreamResponse",
      "tool"
    ].sort());
    expectStability(agents, "stable");
  });

  it("exposes stable persistence, tracing, evaluation, and support helpers from ops", () => {
    expect(ops.createInMemoryAgentRunStore).toBeTypeOf("function");
    expect(ops.createPostgresAgentMemoryStore).toBeTypeOf("function");
    expect(ops.createProductionTraceCollector).toBeTypeOf("function");
    expect(ops.createAgentEvaluationFixture).toBeTypeOf("function");
    expect(ops.createProviderSupportMatrix).toBeTypeOf("function");
    expect(ops.estimateAgentRunCost).toBeTypeOf("function");
    expectStability(ops, "stable");
  });

  it("exposes stable control-plane contracts from a dedicated entry point", () => {
    expect(controlPlane.createAgentCapsule).toBeTypeOf("function");
    expect(controlPlane.createAgentControlPlane).toBeTypeOf("function");
    expect(controlPlane.normalizeAgentCapsuleManifest).toBeTypeOf("function");
    expect(controlPlane.normalizeAgentApprovalQueueItem).toBeTypeOf("function");
    expect(controlPlane.normalizeAgentRunLedger).toBeTypeOf("function");
    expect(controlPlane.migrateAgentCapsuleManifest).toBeTypeOf("function");
    expect(controlPlane.migrateAgentApprovalQueueItem).toBeTypeOf("function");
    expect(controlPlane.migrateAgentRunLedger).toBeTypeOf("function");
    expect("getHostedToolClass" in controlPlane).toBe(false);
    expect("createAgentControlPlane" in agents).toBe(false);
    expectStability(controlPlane, "stable");
  });

  it("keeps beta as a compatible alias with beta-only governance helpers", () => {
    expect(beta.createAgentCapsule).toBe(controlPlane.createAgentCapsule);
    expect(beta.createAgentControlPlane).toBe(controlPlane.createAgentControlPlane);
    expect(beta.createAgentExecutionEnvironmentBinding).toBeTypeOf("function");
    expect(beta.createAgentHarnessBinding).toBeTypeOf("function");
    expect(beta.fingerprintAgentHarness).toBeTypeOf("function");
    expect(beta.createAgentApprovalQueue).toBeTypeOf("function");
    expect(beta.createAgentRunLedger).toBeTypeOf("function");
    expect(beta.createAgentCapabilityRouter).toBeTypeOf("function");
    expect(beta.createAgentAuditRecord).toBeTypeOf("function");
    expect(getApiStability("createAgentControlPlane")).toMatchObject({ stability: "stable" });
    expect(getApiStability("createAgentAuditRecord")).toMatchObject({ stability: "beta" });
    expect(getApiStability("getHostedToolClass")).toMatchObject({ stability: "beta" });
  });

  it("keeps stable realtime and deterministic testing helpers on dedicated entry points", () => {
    expect(sortedKeys(realtime)).toEqual(["streamLiveAgent"]);
    expect(sortedKeys(testing)).toEqual(["createMockLanguageModel", "createMockTool"]);
    expect("streamLiveAgent" in agents).toBe(false);
    expect("createMockLanguageModel" in agents).toBe(false);
    expectStability(realtime, "stable");
    expectStability(testing, "stable");
  });

  it("does not expose broad non-agent or obsolete standalone helpers", () => {
    expect("generateText" in agents).toBe(false);
    expect("createWorkflow" in agents).toBe(false);
    expect("createAgentRegistry" in agents).toBe(false);
    expect("delegateToAgent" in agents).toBe(false);
  });
});
