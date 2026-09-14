import { expect, it } from "vitest";
import { createAgent, createInMemoryAgentRunStore, runAgentGroup, type AgentGroupRunOutput } from "../src/index.js";
import { createMockLanguageModel } from "../../core/src/testing.js";

it("exports the group state union and stable idempotent identities", async () => {
  const pending: AgentGroupRunOutput["status"] = "waiting_approval";
  expect(pending).toBe("waiting_approval");
  const store = createInMemoryAgentRunStore();
  const group = ["one", "two"].map(id => ({ agent: createAgent({ id, store, model: createMockLanguageModel({ responses: [{ text: id, messages: [{ role: "assistant", parts: [{ type: "text", text: id }] }], finishReason: "stop" }] }) }) }));
  const output = await runAgentGroup(group, { prompt: "run", idempotencyKey: "sdk-group" });
  expect(output.status).toBe("completed");
  expect(output.outputs.map(x => x.output!.outputText)).toEqual(["one", "two"]);
  expect(new Set(output.outputs.map(x => x.output!.state.runId)).size).toBe(2);
});
