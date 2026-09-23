import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const fixtureProject = path.join(
  repoRoot,
  "packages/core/tests/fixtures/agent-context-types/tsconfig.json"
);

describe("agent context types", () => {
  it("separates schema input from parsed context", async () => {
    const tsc = path.join(repoRoot, "node_modules", ".bin", "tsc");

    await expect(execFileAsync(tsc, ["--project", fixtureProject], { cwd: repoRoot })).resolves.toMatchObject({
      stdout: "",
      stderr: ""
    });
  }, 30_000);
});
