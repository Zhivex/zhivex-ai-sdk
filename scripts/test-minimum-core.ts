import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareVersions } from "./check-release-readiness";
import { loadWorkspaceCoreMinimums } from "./minimum-core-matrix";
import { minimumFromRange, workspaceCoreVersion, type PackageManifest } from "./minimum-core";

/** Published declarations point at source files that are not in the npm tarball. */
const stripPublishedSourceMaps = (directory: string) => {
  const marker = path.join(directory, ".source-maps-stripped");
  if (existsSync(marker)) return;
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const source = readFileSync(fullPath, "utf8");
      const stripped = source.replace(/^[ \t]*\/\/# sourceMappingURL=.*\r?$/gmu, "");
      if (stripped !== source) writeFileSync(fullPath, stripped);
    }
  };
  visit(directory);
  writeFileSync(marker, "");
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const packageFlag = process.argv.indexOf("--package");
const packageName = packageFlag === -1 ? undefined : process.argv[packageFlag + 1];
if (!packageName || packageName.startsWith("--")) {
  throw new Error("Usage: bun run scripts/test-minimum-core.ts --package <workspace-package>");
}

const coreManifest = JSON.parse(readFileSync(path.join(repoRoot, "packages/core/package.json"), "utf8")) as PackageManifest;
const workspaceCore = workspaceCoreVersion(coreManifest);
const rows = await loadWorkspaceCoreMinimums(repoRoot);
const row = rows.find(entry => entry.package === packageName);
if (!row) {
  throw new Error(`${packageName} does not declare an @zhivex-ai/core dependency or peer dependency.`);
}

const minimum = minimumFromRange(row.range);
if (compareVersions(minimum, workspaceCore) > 0) {
  throw new Error(`${packageName} requires @zhivex-ai/core@${minimum}, which is newer than workspace ${workspaceCore}.`);
}

const args = ["vitest", "run", `packages/${packageName}/tests`];
const env = { ...process.env };

if (compareVersions(minimum, workspaceCore) === 0) {
  console.log(`${packageName} declares ${row.range}; running unit tests against workspace @zhivex-ai/core@${workspaceCore}.`);
} else {
  const cacheRoot = path.join(repoRoot, ".cache", "minimum-core", minimum);
  const coreRoot = path.join(cacheRoot, "package");
  if (!existsSync(path.join(coreRoot, "package.json"))) {
    mkdirSync(cacheRoot, { recursive: true });
    const packed = spawnSync("npm", ["pack", `@zhivex-ai/core@${minimum}`, "--pack-destination", cacheRoot], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    if (packed.status !== 0) {
      throw new Error(`npm pack @zhivex-ai/core@${minimum} failed\n${packed.stdout}\n${packed.stderr}`);
    }
    const tarball = readdirSync(cacheRoot).find(name => name.endsWith(".tgz"));
    if (!tarball) throw new Error(`npm pack produced no tarball for @zhivex-ai/core@${minimum}.`);
    const extracted = spawnSync("tar", ["-xzf", path.join(cacheRoot, tarball), "-C", cacheRoot], { encoding: "utf8" });
    if (extracted.status !== 0) {
      throw new Error(`Failed to extract ${tarball}\n${extracted.stderr}`);
    }
  }
  const packedManifest = JSON.parse(readFileSync(path.join(coreRoot, "package.json"), "utf8")) as PackageManifest;
  if (packedManifest.version !== minimum) {
    throw new Error(`Packed @zhivex-ai/core version ${packedManifest.version} did not match ${minimum}.`);
  }
  stripPublishedSourceMaps(coreRoot);
  env.ZHIVEX_MINIMUM_CORE_ROOT = coreRoot;
  env.ZHIVEX_MINIMUM_CORE_PACKAGE = packageName;
  args.push("--config", "vitest.minimum-core.config.ts");
  console.log(`${packageName} declares ${row.range}; running unit tests against published @zhivex-ai/core@${minimum}.`);
}

const result = spawnSync("bunx", args, { cwd: repoRoot, env, stdio: "inherit" });
process.exit(result.status ?? 1);
