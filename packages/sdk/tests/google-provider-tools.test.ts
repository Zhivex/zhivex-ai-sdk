import { describe, expect, it } from "vitest";
import * as core from "../../core/src/index.js";
import * as sdk from "../src/index.js";
import * as gemini from "../../gemini/src/index.js";
import * as vertex from "../../vertex/src/index.js";

describe("provider-owned Google tool entrypoints", () => {
  it.each([
    "googleCodeExecutionTool", "googleComputerUseTool", "googleFileSearchTool",
    "googleMapsTool", "googleSearchTool", "googleUrlContextTool"
  ] as const)("preserves %s identity across existing and provider imports", (name) => {
    expect(gemini[name]).toBe(core[name]);
    expect(vertex[name]).toBe(core[name]);
    expect(sdk[name]).toBe(core[name]);
  });

  it("retains shared Google wire types without binding tools to one host", () => {
    expect(gemini.googleSearchTool()).toEqual(vertex.googleSearchTool());
    expect(gemini.googleMapsTool({ latitude: 1, longitude: 2 })).toEqual(
      core.googleMapsTool({ latitude: 1, longitude: 2 })
    );
  });
});
