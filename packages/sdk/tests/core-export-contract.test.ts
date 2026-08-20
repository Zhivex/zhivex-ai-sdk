import { describe, expect, it } from "vitest";

import * as core from "@zhivex-ai/core";
import * as beta from "../src/beta.js";
import * as experimental from "../src/experimental.js";
import * as sdk from "../src/index.js";

// These Stable symbols are deliberately kept in core because they are low-level
// adapter, protocol, migration, or security primitives rather than the unified
// application API. Any new core runtime export must be deliberately surfaced or
// added here with an architectural reason.
const intentionallyCoreOnly = [
  "assertTrustedEndpoint",
  "collectUIMessage",
  "createAgentHandoffMessage",
  "decodeBase64WithLimit",
  "encodeAudioFrame",
  "encodeMediaFrame",
  "evaluateAgentBudgetPreflight",
  "getAgentBudgetStatus",
  "getTextFromMessages",
  "getTextFromParts",
  "getToolCallsFromEvents",
  "isCallableToolDefinition",
  "isLoopbackHostname",
  "isPrivateNetworkHostname",
  "isToolRegistry",
  "mergeAbortSignals",
  "migrateAgentApprovalQueueItem",
  "migrateAgentCapsuleManifest",
  "migrateAgentRunLedger",
  "migrateAgentRunState",
  "normalizeAgentApprovalQueueItem",
  "normalizeAgentCapsuleManifest",
  "normalizeAgentRunLedger",
  "normalizeAgentRunState",
  "normalizeFinishReason",
  "normalizeMessages",
  "openWebSocketConnection",
  "providerDataPart",
  "readBodyWithLimit",
  "readErrorBodyWithLimit",
  "readJsonWithLimit",
  "resolveAudioResponseLimits",
  "resultMessages",
  "serializeJsonValue",
  "streamSSE",
  "toolCallPart",
  "toolResultPart",
  "toolResultPayload",
  "unsupportedBrowserToken",
  "validateMessageParts",
  "withRetry",
  "withTimeoutSignal"
] as const;

describe("SDK to core export contract", () => {
  it("requires every core runtime symbol to be public or intentionally core-only", () => {
    const publicSdkSurface = { ...sdk, ...beta, ...experimental };
    const missing = Object.keys(core)
      .filter((symbol) => !(symbol in publicSdkSurface))
      .sort();

    expect(missing).toEqual([...intentionallyCoreOnly].sort());
  });

  it("keeps intentional exclusions classified as Stable core primitives", () => {
    for (const symbol of intentionallyCoreOnly) {
      expect(core.getApiStability(symbol)?.stability, symbol).toBe("stable");
    }
  });
});
