import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const packages = ["agents", "core", "react", "sdk"] as const;
const tsc = path.join(repoRoot, "node_modules", ".bin", "tsc");

const walkDeclarations = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return walkDeclarations(fullPath);
      return entry.name.endsWith(".d.ts") ? [fullPath] : [];
    })
  );
  return files.flat().sort();
};

for (const packageName of packages) {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), `zhivex-api-types-${packageName}-`)
  );
  const outDir = path.join(temp, packageName);
  const tsBuildInfoFile = path.join(temp, `${packageName}.tsbuildinfo`);

  if (packageName !== "core") {
    await execFileAsync(
      tsc,
      [
        "-b",
        path.join(repoRoot, "packages", "core", "tsconfig.json"),
        "--force",
      ],
      { cwd: repoRoot }
    );
  }

  await execFileAsync(
    tsc,
    [
      "--project",
      path.join(repoRoot, "packages", packageName, "tsconfig.json"),
      "--emitDeclarationOnly",
      "--declarationMap",
      "false",
      "--outDir",
      outDir,
      "--tsBuildInfoFile",
      tsBuildInfoFile,
    ],
    { cwd: repoRoot }
  );

  const hashes: Record<string, string> = {};
  for (const file of await walkDeclarations(outDir)) {
    const relativePath = path.relative(outDir, file).split(path.sep).join("/");
    const content = `${(await readFile(file, "utf8"))
      .replace(/\r\n/g, "\n")
      .trim()}\n`;
    hashes[relativePath] = createHash("sha256").update(content).digest("hex");
  }

  const snapshotPath = path.join(
    repoRoot,
    "packages/core/tests/fixtures/api-type-snapshots",
    `${packageName}.json`
  );
  await writeFile(snapshotPath, `${JSON.stringify(hashes, null, 2)}\n`, "utf8");
  console.log(`Updated ${path.relative(repoRoot, snapshotPath)} (${Object.keys(hashes).length} declarations)`);
}
