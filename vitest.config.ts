import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export const workspaceAliases = {
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
