import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
// Strict production persistence/route checks; development-only fixtures stay in the dev suite.
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: "**/convergence.spec.ts",
  outputDir: "./test-results/convergence-production",
  reporter: [["list"], ["html", { outputFolder: "playwright-report/production-convergence", open: "never" }]],
  webServer: { ...base.webServer, command: "npm run start", url: "http://127.0.0.1:3100", reuseExistingServer: false, timeout: 120_000 },
});
