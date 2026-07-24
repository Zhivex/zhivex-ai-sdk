import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const packagesRoot = path.join(repoRoot, "packages");
const packages = await readdir(packagesRoot, { withFileTypes: true });

for (const entry of packages) {
  if (!entry.isDirectory()) continue;
  const dist = path.join(packagesRoot, entry.name, "dist");
  if (path.dirname(path.dirname(dist)) !== packagesRoot) {
    throw new Error(`Refusing to clean unexpected build path: ${dist}`);
  }
  await rm(dist, { recursive: true, force: true });
}
