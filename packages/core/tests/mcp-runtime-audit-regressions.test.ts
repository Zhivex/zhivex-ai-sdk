import { describe, expect, it, vi } from "vitest";
import { createMcpToolSet } from "../src/mcp.js";

describe("MCP runtime schema boundaries", () => {
  it("checks nested JSON literals structurally instead of accepting the same top-level shape", async () => {
    const tools = await createMcpToolSet({
      listTools: async () => [{ name: "confirm", inputSchema: { type: "object", required: ["operation"], additionalProperties: false,
        properties: { operation: { const: { route: "approved", checks: [true, { permission: "read" }] } } } } }],
      callTool: async () => null
    });
    const schema = tools.confirm!.schema;
    expect(schema.safeParse({ operation: { checks: [true, { permission: "read" }], route: "approved" } }).success).toBe(true);
    for (const operation of [
      { route: "approved", checks: [true, { permission: "write" }] },
      { route: "approved", checks: [true] },
      { route: "approved", checks: [true, { permission: "read" }], extra: true },
      { route: "other", checks: [true, { permission: "read" }] }
    ]) expect(schema.safeParse({ operation }).success).toBe(false);
  });

  it("preserves nullable union constraints and excludes filtered remote tools", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const tools = await createMcpToolSet({
      listTools: async () => [{ name: "allowed", inputSchema: { type: ["string", "null"], minLength: 3 } }, { name: "excluded" }, { name: "unlisted" }], callTool
    }, { includeTools: ["allowed", "excluded"], excludeTools: ["excluded"], toolNamePrefix: "remote_" });
    expect(Object.keys(tools)).toEqual(["remote_allowed"]);
    expect(tools.remote_allowed!.schema.safeParse(null).success).toBe(true);
    expect(tools.remote_allowed!.schema.safeParse("abc").success).toBe(true);
    expect(tools.remote_allowed!.schema.safeParse("a").success).toBe(false);
    expect(tools.remote_allowed!.schema.safeParse(2).success).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
  });
});
