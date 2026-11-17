import { test, expect } from "@playwright/test";
import { createServer } from "vite";

let server;
let url;
test.beforeAll(async () => {
  server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/test/fixture.html`;
});
test.afterAll(async () => { await server.close(); });

test("decorates marked Team rows and keeps native navigation and the roster independent", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 640, height: 460 });
  await page.goto(url);
  if (process.env.BUZZ_THEME_CSS) await page.addStyleTag({ path: process.env.BUZZ_THEME_CSS });
  if (process.env.BUZZ_FONT_CSS) await page.addStyleTag({ path: process.env.BUZZ_FONT_CSS });
  const sidebar = page.getByRole("navigation", { name: "Buzz sidebar" });
  await expect(page.getByRole("checkbox", { name: "Studio" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Announcements" })).toHaveCount(0);
  await expect(sidebar.getByRole("list", { name: "Recent Huddle participants" })).toHaveCount(0);
  const studioRow = sidebar.getByRole("button", { name: "Studio", exact: true });
  await expect(studioRow.locator("svg")).toBeHidden();
  await expect(sidebar.getByRole("button", { name: "general", exact: true }).locator("svg")).toBeVisible();
  expect(await studioRow.evaluate((button) => getComputedStyle(button.firstElementChild, "::before").maskImage)).toContain("data:image/svg+xml");

  await page.evaluate(() => window.fixture.join());
  const disclosure = sidebar.getByRole("button", { name: "Studio · Recent Huddle participants · 2" });
  const roster = sidebar.getByRole("list", { name: "Recent Huddle participants" });
  await expect(roster.locator(".h2s2-voice-name")).toHaveText(["Alex", "Riley"]);
  if (browserName === "chromium" && process.env.BUZZ_SCREENSHOT) {
    await page.getByRole("checkbox", { name: "Playtesting" }).check();
    await page.evaluate(() => document.fonts.ready);
    await sidebar.screenshot({ path: process.env.BUZZ_SCREENSHOT });
    await page.getByRole("checkbox", { name: "Playtesting" }).uncheck();
  }
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(roster).toBeHidden();
  await studioRow.click();
  await expect(page.locator("output")).toHaveText("Studio");
  await disclosure.click();
  await expect(roster).toBeVisible();
  await page.evaluate(() => window.fixture.leave());
  await expect(roster).toBeHidden();
  await page.evaluate(() => window.fixture.revoke());
  await expect(disclosure).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.fixture.activeViews())).toEqual([]);
});

test("locally chooses additional rooms, isolates community preferences, and supports a solo preview", async ({ page }) => {
  await page.goto(url);
  const sidebar = page.getByRole("navigation", { name: "Buzz sidebar" });
  await page.getByRole("checkbox", { name: "Playtesting" }).check();
  await expect(sidebar.getByRole("button", { name: "Playtesting", exact: true }).locator("svg")).toBeVisible();
  await page.getByRole("checkbox", { name: "Show sample roster" }).check();
  await expect(sidebar.getByRole("list", { name: "Sample roster" })).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Playtesting" })).toBeChecked();
  await expect(sidebar.getByRole("list", { name: "Sample roster" })).toHaveCount(2);
  await page.evaluate(() => window.fixture.switchCommunity());
  await expect(page.getByRole("checkbox", { name: "Playtesting" })).not.toBeChecked();
  await expect(sidebar.getByRole("list", { name: "Sample roster" })).toHaveCount(0);
});
