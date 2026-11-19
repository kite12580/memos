import { defineConfig } from "@playwright/test";

const port = 5299;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://localhost:${port}`,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  },
  webServer: {
    command: `node scripts/e2e-server.mjs ${port}`,
    url: `http://localhost:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
