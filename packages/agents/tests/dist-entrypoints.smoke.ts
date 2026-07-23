import assert from "node:assert/strict";

// Package self-references exercise package.json exports and the emitted dist
// files without installing dependencies or contacting a registry.
import * as beta from "@zhivex-ai/agents/beta";
import * as agents from "@zhivex-ai/agents";
import * as ops from "@zhivex-ai/agents/ops";
import * as realtime from "@zhivex-ai/agents/realtime";
import * as testing from "@zhivex-ai/agents/testing";

assert.equal(typeof agents.Agent, "function");
assert.equal(agents.AGENT_RUN_STATE_SCHEMA_VERSION, 1);
assert.equal(typeof agents.normalizeAgentRunState, "function");
assert.equal(typeof agents.runAgent, "function");
assert.equal(typeof agents.tool, "function");
assert.equal("createAgentRunLedger" in agents, false);

assert.equal(typeof ops.createInMemoryAgentRunStore, "function");
assert.equal(typeof ops.createAgentTraceCollector, "function");
assert.equal(typeof ops.runAgentEvaluation, "function");

assert.equal(typeof beta.createAgentControlPlane, "function");
assert.equal(typeof beta.createAgentRunLedger, "function");

assert.equal(typeof realtime.streamLiveAgent, "function");
assert.equal(typeof testing.createMockLanguageModel, "function");

console.log("@zhivex-ai/agents dist entrypoints: ok");
