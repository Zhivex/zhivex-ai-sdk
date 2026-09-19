import assert from "node:assert/strict";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const vertex = createVertex({ ...credentials.options, location: "global" });
const modelId = "claude-sonnet-4-6";
for (const operation of ["countTokens", "generate"] as const) {
  try {
    if (operation === "countTokens") {
      const result = await vertex.claude.countTokens({ modelId, messages: [{ role: "user", content: "Reply with exactly: vertex-claude-ok" }], timeoutMs: 30_000, maxRetries: 0 });
      assert.ok(Number.isSafeInteger(result.inputTokens) && result.inputTokens > 0);
      console.log(JSON.stringify({ operation, verified: true, inputTokens: result.inputTokens }));
    } else {
      const result = await vertex(modelId).generate({ messages: [{ role: "user", parts: [{ type: "text", text: "Reply with exactly: vertex-claude-ok" }] }], maxTokens: 128, timeoutMs: 30_000, maxRetries: 0 });
      assert.equal(result.text.trim(), "vertex-claude-ok");
      assert.ok((result.usage?.inputTokens ?? 0) > 0);
      console.log(JSON.stringify({ operation, verified: true, usage: result.usage }));
    }
  } catch (error) {
    console.log(JSON.stringify({ operation, verified: false, error: (error as Error).name, status: (error as { status?: number }).status }));
    process.exitCode = 1;
  }
}
