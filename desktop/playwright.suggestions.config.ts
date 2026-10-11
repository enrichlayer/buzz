import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Isolate the prototype from other worktrees' preview servers.
export default defineConfig({
  ...base,
  projects: [
    { name: "suggestions", testMatch: "**/prompt-suggestions.spec.ts" },
  ],
  use: { ...base.use, baseURL: "http://127.0.0.1:4192" },
  webServer: {
    command: "python3 -m http.server 4192 -d dist",
    url: "http://127.0.0.1:4192",
    reuseExistingServer: false,
  },
});
