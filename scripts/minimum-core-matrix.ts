import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { coreMinimums, type PackageManifest } from "./minimum-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const loadWorkspaceCoreMinimums = async (root = repoRoot) => {
  const packageRoot = path.join(root, "packages");
  const entries = await readdir(packageRoot, { withFileTypes: true });
  const manifests = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => ({
    package: entry.name,
    manifest: JSON.parse(await readFile(path.join(packageRoot, entry.name, "package.json"), "utf8")) as PackageManifest
  })));
  return coreMinimums(manifests);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const include = await loadWorkspaceCoreMinimums();
  process.stdout.write(`${JSON.stringify({ include })}\n`);
}
