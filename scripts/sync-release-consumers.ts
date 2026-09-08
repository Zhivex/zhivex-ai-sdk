import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Keep the standalone starter on the exact versions produced by Changesets. */
export const syncReleaseConsumers = async (repoRoot: string): Promise<boolean> => {
  const starterPath = path.join(repoRoot, "examples/next-runner/package.json");
  const original = await readFile(starterPath, "utf8");
  const starter = JSON.parse(original);
  let changed = false;
  for (const name of ["sdk", "openai", "react"]) {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "packages", name, "package.json"), "utf8"));
    if (typeof manifest.version !== "string" || !manifest.version) {
      throw new Error(`Missing release version for @zhivex-ai/${name}`);
    }
    const dependency = `@zhivex-ai/${name}`;
    if (starter.dependencies?.[dependency] === undefined) {
      throw new Error(`Starter is missing ${dependency}`);
    }
    if (starter.dependencies[dependency] !== manifest.version) {
      starter.dependencies[dependency] = manifest.version;
      changed = true;
    }
  }
  if (changed) await writeFile(starterPath, `${JSON.stringify(starter, null, 2)}\n`);
  return changed;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = await syncReleaseConsumers(path.resolve(import.meta.dirname, ".."));
  console.log(changed ? "Updated standalone starter release versions." : "Standalone starter release versions are aligned.");
}
