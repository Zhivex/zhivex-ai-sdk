import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import coreManifest from "./packages/core/package.json" with { type: "json" };

export const workspaceAliases = {
  // Resolve focused subpaths before the root alias, always against source.
  ...Object.fromEntries(Object.entries(coreManifest.exports)
    .filter(([subpath]) => subpath !== ".")
    .map(([subpath, target]) => [
      `@zhivex-ai/core/${subpath.slice(2)}`,
      resolve(import.meta.dirname, "packages/core/src", target.import.replace("./dist/", "").replace(/\.js$/, ".ts"))
    ])),
  "#secure-id": resolve(import.meta.dirname, "packages/core/src/secure-id-node.ts"),
  "@zhivex-ai/core": resolve(import.meta.dirname, "packages/core/src/index.ts"),
  "@zhivex-ai/openai": resolve(import.meta.dirname, "packages/openai/src/index.ts"),
  "@zhivex-ai/deepseek": resolve(import.meta.dirname, "packages/deepseek/src/index.ts"),
  "@zhivex-ai/zai": resolve(import.meta.dirname, "packages/zai/src/index.ts"),
  "@zhivex-ai/anthropic": resolve(import.meta.dirname, "packages/anthropic/src/index.ts"),
  "@zhivex-ai/gemini": resolve(import.meta.dirname, "packages/gemini/src/index.ts"),
  "@zhivex-ai/react": resolve(import.meta.dirname, "packages/react/src/index.ts"),
  "@zhivex-ai/sdk": resolve(import.meta.dirname, "packages/sdk/src/index.ts")
};

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/tests/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "packages/**/tests/**/*.integration.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 80,
      },
    },
  },
  resolve: {
    alias: workspaceAliases
  }
});
