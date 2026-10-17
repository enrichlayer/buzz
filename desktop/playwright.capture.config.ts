import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual-evidence",
  testMatch: /\.capture\.ts$/,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  outputDir: join(
    process.env.EL_VE_OUTPUT_DIR ?? "test-results/visual-evidence",
    "__pw-artifacts__",
  ),
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    video: process.env.EL_VE_RECORD_VIDEO === "1" ? "on" : "off",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "tablet", use: { viewport: { width: 820, height: 1180 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "python3 -m http.server 4173 -d dist",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: !process.env.CI,
      },
});
