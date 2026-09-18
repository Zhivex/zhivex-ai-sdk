import { expect, it } from "vitest";
import { createAgent, streamAgent, toUIMessageStream } from "../src/index.js";
import { createMockLanguageModel } from "../src/testing.js";
import { createRunViewSink, runViewParent } from "../src/agent-run-view.js";
import type { AgentRunView } from "../src/types.js";

it("streams safe root execution summaries without changing first/last lifecycle events", async () => {
  const agent = createAgent({ id: "root", name: "Research", model: createMockLanguageModel({ streamEvents: [[{ type: "text-delta", textDelta: "hello" }, { type: "finish", finishReason: "stop" }]] }), instructions: "PRIVATE INSTRUCTIONS", policy: { budget: { maxTotalTokens: 900 } } });
  const result = streamAgent(agent, { prompt: "PRIVATE PROMPT" });
  const events = []; for await (const event of result.eventStream) events.push(event);
  expect(events[0]!.type).toBe("agent-run-start"); expect(events.at(-1)!.type).toBe("agent-run-finish");
  const updates = events.filter(event => event.type === "agent-run-update");
  expect(updates.at(-1)!.run).toMatchObject({ name: "Research", status: "completed", budget: { maxTotalTokens: 900 } });
  expect(JSON.stringify(updates)).not.toContain("PRIVATE");
  const ui = []; for await (const event of toUIMessageStream((async function* () { yield* updates; })())) ui.push(event);
  expect(ui).toEqual(updates);
});
it("keeps distinct child identities and strips handoff contents", async () => {
  const views: AgentRunView[] = [];
  const sink = createRunViewSink(async run => { views.push(run); });
  const agent = { ...createAgent({ model: createMockLanguageModel() }), [runViewParent]: "parent" };
  for (const runId of ["a", "b"]) await sink({ type: "run-start", runId, agentId: "same", provider: "test", modelId: "test", maxSteps: 2 }, agent);
  await sink({ type: "handoff", runId: "a", handoff: { id: "h", fromRunId: "a", toAgentId: "next", summary: "PRIVATE", contextMessages: [] } }, agent);
  expect(views.map(view => view.runId)).toEqual(["a", "b", "a"]);
  expect(views[0]!.parentRunId).toBe("parent"); expect(views[2]!.handoffToAgentId).toBe("next"); expect(JSON.stringify(views)).not.toContain("PRIVATE");
});
it("forwards child lifecycle from real subagent execution to the parent UI stream", async () => {
  const child = createAgent({ id: "child", name: "Researcher", model: createMockLanguageModel({ responses: [{ text: "child result", messages: [{ role: "assistant", parts: [{ type: "text", text: "child result" }] }], finishReason: "stop" }] }) });
  const model = createMockLanguageModel({ streamEvents: [
    [{ type: "tool-call", toolCall: { id: "call", name: "research", input: { prompt: "Investigate" } } }, { type: "finish", finishReason: "tool-calls" }],
    [{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop" }]
  ] });
  const stream = streamAgent(createAgent({ id: "parent", model, maxSteps: 3, subagents: [{ name: "research", agent: child }] }), { prompt: "Delegate research" });
  const updates: AgentRunView[] = [];
  for await (const event of stream.eventStream) if (event.type === "agent-run-update") updates.push(event.run);
  const result = await stream.collect();
  const childUpdates = updates.filter(run => run.agentId === "child");
  expect(childUpdates.length).toBeGreaterThan(1);
  expect(childUpdates.at(-1)).toMatchObject({ parentRunId: result.state.runId, status: "completed", name: "Researcher" });
});
