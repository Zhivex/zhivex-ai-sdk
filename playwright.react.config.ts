import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "packages/react/browser", testMatch: "**/*.spec.ts",
  fullyParallel: false, workers: 1, timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4178", browserName: "chromium", trace: "retain-on-failure" },
  webServer: { command: "bun run scripts/react-browser-server.ts", url: "http://127.0.0.1:4178", reuseExistingServer: !process.env.CI },
  outputDir: ".cache/react-browser-results"
});
