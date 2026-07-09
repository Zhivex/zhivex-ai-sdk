import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export const workspaceAliases = {
  "@zhivex-ai/core": resolve(__dirname, "packages/core/src/index.ts"),
  "@zhivex-ai/openai": resolve(__dirname, "packages/openai/src/index.ts"),
  "@zhivex-ai/deepseek": resolve(__dirname, "packages/deepseek/src/index.ts"),
  "@zhivex-ai/anthropic": resolve(__dirname, "packages/anthropic/src/index.ts"),
  "@zhivex-ai/gemini": resolve(__dirname, "packages/gemini/src/index.ts"),
  "@zhivex-ai/sdk": resolve(__dirname, "packages/sdk/src/index.ts")
};

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/tests/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "packages/**/tests/**/*.integration.test.ts"]
  },
  resolve: {
    alias: workspaceAliases
  }
});
