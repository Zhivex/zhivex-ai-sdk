import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRoot, ".cache", "browser-bundle-check");

// Bundle the generation and provider entrypoints. Those are the browser/edge
// surfaces: package `#imports` resolve from dist, and Bun's browser target is
// also the edge bundle. The root and SDK barrels still reach Node-only crypto
// and filesystem code, so they are not part of this smoke.
const entries = [
  ["core-generation", "packages/core/dist/generation-entry.js"],
  ["core-provider", "packages/core/dist/provider-entry.js"]
] as const;

const sourceHasNodeUtil = (directory: string): string[] => {
  const hits: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      hits.push(...sourceHasNodeUtil(fullPath));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const source = readFileSync(fullPath, "utf8");
    if (/from\s+["']node:util["']/.test(source)) hits.push(path.relative(repoRoot, fullPath));
  }
  return hits;
};

const nodeUtilImports = sourceHasNodeUtil(path.join(repoRoot, "packages/core/src"));
if (nodeUtilImports.length) {
  throw new Error(`@zhivex-ai/core still imports node:util:\n${nodeUtilImports.join("\n")}`);
}

for (const [, entry] of entries) {
  if (!existsSync(path.join(repoRoot, entry))) {
    throw new Error(`Missing build output ${entry}. Run bun run build before the browser/edge bundle check.`);
  }
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

for (const [name, entry] of entries) {
  const outfile = path.join(outputDir, `${name}-browser.js`);
  const result = spawnSync("bun", ["build", entry, "--target=browser", "--outfile", outfile], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`bun build --target=browser failed for ${entry}\n${result.stdout}\n${result.stderr}`);
  }
  const bundled = readFileSync(outfile, "utf8");
  // Bun inlines a `node:util` polyfill and labels that chunk `// node:util`.
  // A remaining import specifier means the module was not bundled.
  if (/from\s+["']node:util["']|require\(\s*["']node:util["']\s*\)/.test(bundled)) {
    throw new Error(`${entry} browser bundle still imports node:util.`);
  }
}

console.log("Browser/edge bundles built without node:util for core/generation and core/provider.");
