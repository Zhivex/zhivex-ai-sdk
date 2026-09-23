import { z } from "zod";
import { Agent, createAgent, runAgent, streamAgent, resumeAgent, ConflictError } from "../../../../agents/src/index.js";
import { createMockLanguageModel } from "../../../src/agent-evaluation.js";
const contextSchema = z.object({ count: z.string().transform(Number), enabled: z.boolean().default(true) });
const definition = createAgent({ model: createMockLanguageModel(), contextSchema });
const agent = new Agent({ ...definition, inputGuardrails: [({ context }) => {
  const count: number = context!.count;
  const enabled: boolean = context!.enabled;
  void [count, enabled];
}] });
agent.run({ context: { count: "42" } });
agent.stream({ context: { count: "42" } });
runAgent(definition, { context: { count: "42" } });
streamAgent(definition, { context: { count: "42" } });
declare const state: import("../../../src/types.js").AgentRunState;
resumeAgent(definition, { state, context: { count: "42" } });
agent.resume({ state, context: { count: "42" } });
// @ts-expect-error The schema accepts a string, not its numeric output.
agent.run({ context: { count: 42 } });
// @ts-expect-error Functional APIs also require schema input.
runAgent(definition, { context: { count: 42 } });
// @ts-expect-error Resume must receive raw context again.
resumeAgent(definition, { state, context: { count: 42 } });
const error: Error = new ConflictError("conflict");
void error;
