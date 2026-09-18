import { defineConfig } from "@playwright/test";
// Explicit opt-in: this suite makes billable calls with server-side credentials.
export default defineConfig({
  testDir: "packages/react/browser", testMatch: "live.spec.ts", workers: 1, timeout: 180_000,
  use: { baseURL: "http://127.0.0.1:4179", browserName: "chromium", trace: "off" },
  webServer: { command: "bun --env-file=.env run examples/react-omni/server.ts", url: "http://127.0.0.1:4179", reuseExistingServer: !process.env.CI },
  outputDir: ".cache/react-live-results"
});
