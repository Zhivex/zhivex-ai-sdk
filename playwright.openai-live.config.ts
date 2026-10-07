import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "packages/openai/browser", testMatch: "live-webrtc.spec.ts", workers: 1, timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4186", browserName: "chromium", permissions: [] },
  webServer: { command: "bun run scripts/openai-live-webrtc-browser-server.ts", url: "http://127.0.0.1:4186", reuseExistingServer: false },
  outputDir: ".cache/openai-live-webrtc-results"
});
