import { describe, expect, it } from "vitest";
import { toolResultPayload, type ModelCapabilities, type ModelGenerateInput } from "../src/index.js";

describe("portable tool history format", () => {
  it("keeps error-shaped successful JSON distinguishable from actual errors", () => {
    const error = { message: "failure" };
    const base = { toolCallId: "call", toolName: "weather" };
    expect(toolResultPayload({ ...base, isError: false, output: { error } })).toEqual({ output: { error } });
    expect(toolResultPayload({ ...base, isError: true, error })).toEqual({ error });
    expect(toolResultPayload({ ...base, isError: false, output: null })).toEqual({ output: null });
    const capability: Pick<ModelCapabilities, "toolHistory"> = { toolHistory: "json" };
    const input: Pick<ModelGenerateInput, "toolResultFormat"> = { toolResultFormat: "envelope" };
    expect([capability.toolHistory, input.toolResultFormat]).toEqual(["json", "envelope"]);
  });
});
