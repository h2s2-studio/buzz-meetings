import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "sidebar.spec.mjs",
  projects: ["chromium", "webkit"].map((browserName) => ({ name: browserName, use: { browserName } })),
});
