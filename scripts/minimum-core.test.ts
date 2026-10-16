import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { compareVersions } from "./check-release-readiness";
import { coreMinimums, minimumFromRange, workspaceCoreVersion, type PackageManifest } from "./minimum-core";
import { loadWorkspaceCoreMinimums } from "./minimum-core-matrix";

describe("minimum core ranges", () => {
  it("reads caret and tilde floors, including prerelease", () => {
    expect(minimumFromRange("^1.27.0")).toBe("1.27.0");
    expect(minimumFromRange("~1.32.0")).toBe("1.32.0");
    expect(minimumFromRange("^1.23.0-next.2")).toBe("1.23.0-next.2");
  });

  it("rejects ranges that do not pin a single floor", () => {
    expect(() => minimumFromRange(">=1.27.0")).toThrow(/Unsupported/);
    expect(() => minimumFromRange("^1.27.0 || ^2.0.0")).toThrow(/Unsupported/);
    expect(() => minimumFromRange("*")).toThrow(/Unsupported/);
  });

  it("keeps the higher floor when dependency and peer both declare core", () => {
    expect(coreMinimums([
      {
        package: "widget",
        manifest: {
          dependencies: { "@zhivex-ai/core": "^1.2.0" },
          peerDependencies: { "@zhivex-ai/core": "^1.4.0" }
        }
      },
      {
        package: "core",
        manifest: { name: "@zhivex-ai/core", version: "1.4.0", dependencies: {} }
      }
    ])).toEqual([{ package: "widget", core: "1.4.0", range: "^1.4.0" }]);
  });

  it("floors adapters that import this checkout's core helpers at the workspace core", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const core = JSON.parse(await readFile(path.join(repoRoot, "packages/core/package.json"), "utf8")) as PackageManifest;
    const rows = await loadWorkspaceCoreMinimums(repoRoot);
    const version = workspaceCoreVersion(core);
    for (const packageName of ["deepseek", "gateway", "kimi", "meta", "ollama", "openrouter", "sandbox-docker", "zai"]) {
      const row = rows.find(entry => entry.package === packageName);
      expect(row, packageName).toBeDefined();
      expect(compareVersions(row!.core, version), `${packageName} declares ${row?.range}`).toBe(0);
    }
    expect(rows.some(entry => entry.package === "core")).toBe(false);
    expect(rows.find(entry => entry.package === "sdk")?.range.startsWith("~")).toBe(true);
  });
});
