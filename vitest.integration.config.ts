import { defineConfig } from "vitest/config";

import { workspaceAliases } from "./vitest.config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/tests/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000
  },
  resolve: {
    alias: workspaceAliases
  }
});
