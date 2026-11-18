import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "agent-screen.probe.mjs",
  workers: 1,
  projects: ["chromium", "webkit"].map(browserName => ({ name: browserName, use: { browserName } })),
});
