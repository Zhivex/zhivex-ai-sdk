import { expect, it, vi } from "vitest";
import { Agent, createMockLanguageModel, createTextMessage, type AgentRunInput } from "../src/index.js";

it("keeps default memory compatible and exposes opt-out through the SDK facade", async () => {
  const memory = { load: vi.fn(() => []), save: vi.fn(() => {}) };
  const agent = new Agent({ memory, model: createMockLanguageModel({ responses: [
    { text: "Done", messages: [createTextMessage("assistant", "Done")], finishReason: "stop" },
    { text: "Default", messages: [createTextMessage("assistant", "Default")], finishReason: "stop" }
  ] }) });
  const input: AgentRunInput = { prompt: "Private invocation", memory: false };
  expect((await agent.run(input)).status).toBe("completed");
  expect(memory.load).not.toHaveBeenCalled();
  expect(memory.save).not.toHaveBeenCalled();
  await agent.run({ prompt: "Use defaults" });
  expect(memory.load).toHaveBeenCalled();
  expect(memory.save).toHaveBeenCalled();
});
