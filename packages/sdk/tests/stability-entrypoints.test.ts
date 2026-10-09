import { describe, expect, it } from "vitest";

import * as mcp from "../src/mcp-http.js";
import * as coreMcp from "../../core/src/mcp-http.js";
import * as mcpStdio from "../src/mcp-stdio.js";
import * as coreMcpStdio from "../../core/src/mcp-stdio.js";
import * as mcpStdioBrowser from "../src/mcp-stdio-browser.js";
import * as coreMcpStdioBrowser from "../../core/src/mcp-stdio-browser.js";
import * as beta from "../src/beta.js";
import * as experimental from "../src/experimental.js";
import * as coreExperimental from "../../core/src/experimental-entry.js";
import { getApiStability, runComputerUse } from "../src/index.js";

describe("SDK stability entrypoints", () => {
  it("exposes the same portable computer-use runner as core and the root", () => {
    expect(experimental.runComputerUse).toBe(runComputerUse);
    expect(experimental.runComputerUse).toBe(coreExperimental.runComputerUse);
    expect(typeof experimental.runComputerUse).toBe("function");
  });

  it("contains only Beta runtime symbols", () => {
    for (const symbol of Object.keys(beta)) {
      expect(getApiStability(symbol)?.stability, symbol).toBe("beta");
    }
  });

  it("contains only Experimental runtime symbols", () => {
    for (const symbol of Object.keys(experimental)) {
      expect(getApiStability(symbol)?.stability, symbol).toBe("experimental");
    }
  });
});

describe("Experimental MCP stdio entrypoints", () => {
  it("classifies every opt-in export and preserves core/SDK parity", () => {
    expect(Object.keys(mcpStdio).sort()).toEqual(Object.keys(coreMcpStdio).sort());
    expect(Object.keys(mcpStdio.MCP_STDIO_API_STABILITY_MANIFEST).sort()).toEqual(Object.keys(mcpStdio).sort());
    expect(Object.isFrozen(mcpStdio.MCP_STDIO_API_STABILITY_MANIFEST)).toBe(true);
    for (const level of Object.values(mcpStdio.MCP_STDIO_API_STABILITY_MANIFEST)) expect(level).toBe("experimental");
    expect(mcpStdioBrowser.MCP_STDIO_API_STABILITY_MANIFEST).toEqual(coreMcpStdioBrowser.MCP_STDIO_API_STABILITY_MANIFEST);
    expect(mcpStdioBrowser.MCP_STDIO_API_STABILITY_MANIFEST).toEqual(mcpStdio.MCP_STDIO_API_STABILITY_MANIFEST);
    expect(() => mcpStdioBrowser.createMcpStdioClient()).toThrow(mcpStdioBrowser.McpStdioError);
  });
});

describe("Stable MCP HTTP entrypoints", () => {
  it("classifies every opt-in export and preserves core/SDK parity", () => {
    expect(Object.keys(mcp).sort()).toEqual(Object.keys(coreMcp).sort());
    expect(Object.keys(mcp.MCP_HTTP_API_STABILITY_MANIFEST).sort()).toEqual(Object.keys(mcp).sort());
    expect(Object.isFrozen(mcp.MCP_HTTP_API_STABILITY_MANIFEST)).toBe(true);
    for (const level of Object.values(mcp.MCP_HTTP_API_STABILITY_MANIFEST)) expect(level).toBe("stable");
    expect(getApiStability("createMcpToolSet")?.stability).toBe("stable");
    expect(getApiStability("createMcpToolRegistry")?.stability).toBe("beta");
  });
});
