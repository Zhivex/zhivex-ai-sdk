import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import coreSnapshot from "./fixtures/api-type-snapshots/core.json" with { type: "json" };
import sdkSnapshot from "./fixtures/api-type-snapshots/sdk.json" with { type: "json" };
import agentsSnapshot from "./fixtures/api-type-snapshots/agents.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const declarationSnapshotTimeoutMs = 30_000;
type SnapshotPackageName = "agents" | "core" | "sdk";

const walkDeclarationFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return walkDeclarationFiles(fullPath);
    }
    return entry.name.endsWith(".d.ts") ? [fullPath] : [];
  }));
  return files.flat().sort();
};

const declarationHashes = async (packageName: SnapshotPackageName): Promise<Record<string, string>> => {
  const temp = await mkdtemp(path.join(os.tmpdir(), `zhivex-api-types-${packageName}-`));
  const outDir = path.join(temp, packageName);
  const tsBuildInfoFile = path.join(temp, `${packageName}.tsbuildinfo`);
  const tsc = path.join(repoRoot, "node_modules", ".bin", "tsc");

  if (packageName !== "core") {
    await execFileAsync(tsc, ["-b", path.join(repoRoot, "packages", "core", "tsconfig.json"), "--force"], {
      cwd: repoRoot
    });
  }

  await execFileAsync(tsc, [
    "--project",
    path.join(repoRoot, "packages", packageName, "tsconfig.json"),
    "--emitDeclarationOnly",
    "--declarationMap",
    "false",
    "--outDir",
    outDir,
    "--tsBuildInfoFile",
    tsBuildInfoFile
  ], { cwd: repoRoot });

  const hashes: Record<string, string> = {};
  for (const file of await walkDeclarationFiles(outDir)) {
    const relativePath = path.relative(outDir, file).split(path.sep).join("/");
    const content = `${(await readFile(file, "utf8")).replace(/\r\n/g, "\n").trim()}\n`;
    hashes[relativePath] = createHash("sha256").update(content).digest("hex");
  }
  return hashes;
};

describe("public API type snapshots", () => {
  it("keeps core declaration snapshots explicit", async () => {
    await expect(declarationHashes("core")).resolves.toEqual(coreSnapshot);
  }, declarationSnapshotTimeoutMs);

  it("keeps agents declaration snapshots explicit", async () => {
    await expect(declarationHashes("agents")).resolves.toEqual(agentsSnapshot);
  }, declarationSnapshotTimeoutMs);

  it("keeps sdk declaration snapshots explicit", async () => {
    await expect(declarationHashes("sdk")).resolves.toEqual(sdkSnapshot);
  }, declarationSnapshotTimeoutMs);
});
