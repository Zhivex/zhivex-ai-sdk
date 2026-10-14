import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

import { workspaceAliases } from "./vitest.config.ts";

const coreRoot = process.env.ZHIVEX_MINIMUM_CORE_ROOT;
const packageName = process.env.ZHIVEX_MINIMUM_CORE_PACKAGE;
if (!coreRoot || !packageName) {
  throw new Error("vitest.minimum-core.config.ts requires ZHIVEX_MINIMUM_CORE_ROOT and ZHIVEX_MINIMUM_CORE_PACKAGE.");
}

type ExportTarget = string | { import?: string; default?: string; node?: string; browser?: string };

const manifest = JSON.parse(readFileSync(resolve(coreRoot, "package.json"), "utf8")) as {
  exports?: Record<string, ExportTarget>;
  imports?: Record<string, ExportTarget>;
};

const resolveTarget = (target: ExportTarget | undefined, condition: "node" | "import"): string | undefined => {
  if (!target) return undefined;
  if (typeof target === "string") return target;
  if (condition === "node") return target.node ?? target.import ?? target.default;
  return target.import ?? target.default ?? target.node;
};

const alias: Record<string, string> = {};
for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
  if (subpath === ".") continue;
  const imported = resolveTarget(target, "import");
  if (!imported) continue;
  alias[`@zhivex-ai/core/${subpath.slice(2)}`] = resolve(coreRoot, imported);
}

const internalImport = (name: string, fallback: string) => {
  const imported = resolveTarget(manifest.imports?.[name], "node") ?? fallback;
  return resolve(coreRoot, imported);
};

alias["#secure-id"] = internalImport("#secure-id", "./dist/secure-id-node.js");
alias["#realtime-transport"] = internalImport("#realtime-transport", "./dist/realtime-node.js");

for (const [key, replacement] of Object.entries(workspaceAliases)) {
  if (key.startsWith("@zhivex-ai/core") || key.startsWith("#")) continue;
  alias[key] = replacement;
}

const rootExport = resolveTarget(manifest.exports?.["."], "import");
if (!rootExport) throw new Error(`Published core at ${coreRoot} has no "." export.`);
alias["@zhivex-ai/core"] = resolve(coreRoot, rootExport);

export default defineConfig({
  test: {
    environment: "node",
    include: [`packages/${packageName}/tests/**/*.test.ts`],
    exclude: ["**/node_modules/**", "packages/**/tests/**/*.integration.test.ts"]
  },
  resolve: {
    alias
  }
});
