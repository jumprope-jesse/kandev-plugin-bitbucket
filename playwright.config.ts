import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./ui/e2e",
  timeout: 30_000,
  globalSetup: "./ui/e2e/require-packaged-host.mjs",
  use: {
    baseURL: process.env.KANDEV_PLUGIN_E2E_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "desktop",
      testMatch: /desktop-packaged-plugin\.spec\.ts/,
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: /mobile-packaged-plugin\.spec\.ts/,
      use: { ...devices["Pixel 5"] },
    },
  ],
});
