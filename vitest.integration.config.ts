import { existsSync } from "node:fs";

import { defineConfig } from "vitest/config";

import { workspaceAliases } from "./vitest.config";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/tests/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000
  },
  resolve: {
    alias: workspaceAliases
  }
});
