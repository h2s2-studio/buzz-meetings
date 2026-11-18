import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import { writeFile } from "node:fs/promises";
import { workspaceFixturePlugin } from "./workspace-http.mjs";
import { identities, general, design } from "./workspace-host.mjs";
test.use({ permissions: ["microphone", "camera"] });
let site, fixture;
const upstream = process.env.BUZZ_TEST_UPSTREAM_URL?.replace(/\/rooms\/?$/, "");
test.beforeAll(async () => {
  site = await createServer({ configFile: false, plugins: [workspaceFixturePlugin()], server: { host: "127.0.0.1", port: 0, watch: null,
    ...(upstream && { proxy: { "/rooms": { target: upstream, ws: true, changeOrigin: true, headers: {
      "X-Buzz-Streams-Proxy-Key": process.env.BUZZ_TEST_PROXY_KEY, Origin: "tauri://localhost" } } } }) } });
  await site.listen(); fixture = `http://127.0.0.1:${site.httpServer.address().port}/test/fixture.html`;
});
test.afterAll(async () => { await site.close(); });
const sidebar = page => page.getByRole("navigation", { name: "Meetings", exact: true });
// Temporary meetings (formerly quick rooms) are added and managed from the Meetings "+" dialog.
async function addTemporary(page, name) {
  await sidebar(page).getByRole("button", { name: "Create meeting", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create meeting", exact: true });
  await dialog.getByLabel("Meeting name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Add temporary meeting", exact: true }).click();
}
async function manageTemporary(page) {
  await sidebar(page).getByRole("button", { name: "Create meeting", exact: true }).click();
  await page.getByRole("dialog", { name: "Create meeting", exact: true }).getByRole("button", { name: "Manage temporary meetings", exact: true }).click();
}
const stage = page => page.getByRole("region", { name: "Meeting", exact: true });
const controls = page => stage(page).getByRole("group", { name: "Meeting controls" });
const join = page => sidebar(page).getByRole("button", { name: "Join General Voice", exact: true });
const video = page => page.getByLabel("Shared screen", { exact: true });
// The side panel is a tab set (Chat / Transcript / Agent); reopen it first if it was closed.
async function rail(page, name) {
  const open = page.getByRole("button", { name: "Open side panel", exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole("tab", { name, exact: true }).click();
}
async function startShare(page) {
  const drawer = page.getByRole("dialog", { name: "Screen sharing", exact: true });
  if (!await drawer.isVisible()) await controls(page).getByRole("button", { name: "Share screen", exact: true }).click();
  await drawer.getByRole("button", { name: "Choose screen or window", exact: true }).click();
}
async function playback(locator) {
  await expect(locator).toBeVisible({ timeout: 15000 });
  await expect.poll(() => locator.evaluate(element => element.currentTime)).toBeGreaterThan(0);
}
// Library groups notes, documents & boards and meeting records behind one workspace tab.
async function library(scope, name) {
  await scope.getByRole("group", { name: "Workspace views" }).getByRole("button", { name: "Library", exact: true }).click();
  await scope.getByRole("group", { name: "Library" }).getByRole("button", { name, exact: typeof name === "string" }).click();
}

test("automatically presents rooms, persists names, and reports denied microphone permission", async ({ page }) => {
  await page.goto(`${fixture}?deny`);
  await expect(sidebar(page).getByRole("heading", { name: "Meetings" })).toBeVisible();
  await addTemporary(page, "Design Room");
  await page.reload();
  await expect(sidebar(page).getByRole("button", { name: "Join Design Room" })).toBeVisible();
  await expect(sidebar(page).getByRole("button", { name: "Join Design Room" })).toContainText("Temporary");
  const trigger = sidebar(page).getByRole("button", { name: "Create meeting", exact: true });
  await addTemporary(page, "General Voice");
  const dialog = page.getByRole("dialog", { name: "Create meeting", exact: true });
  await expect(dialog.getByRole("alert")).toContainText("already in your list");
  await expect(dialog.getByLabel("Meeting name", { exact: true })).toHaveValue("General Voice");
  await dialog.getByLabel("Meeting name", { exact: true }).press("Escape");
  await expect(trigger).toBeFocused();
  await join(page).click();
  await expect(page.getByRole("alert")).toContainText("Microphone permission was denied");
  await expect(sidebar(page).getByRole("list", { name: "Connected participants" })).toHaveCount(0);
  expect(await page.evaluate(() => meetingTest.microphoneStates())).toEqual([]);
});
test("top-aligns rooms below host navigation and persists create, rename, and removal", async ({ page }) => {
  await page.setViewportSize({ width: 530, height: 2064 });
  await page.goto(`${fixture}?deny`);
  const activity = await page.getByRole("button", { name: "Activity", exact: true }).boundingBox();
  const heading = await workspaces(page).getByRole("heading", { name: "Meetings",exact:true }).boundingBox();
  expect(heading.y).toBeLessThan(activity.y + activity.height + 64);
  expect(heading.y).toBeLessThan(200);
  // One list: saved temporary meetings sit inside the Meetings section.
  await expect(sidebar(page).getByRole("button", { name: "Join General Voice", exact: true })).toBeVisible();
  await manageTemporary(page);
  await page.getByLabel("Meeting name", { exact: true }).fill("Design Room");
  await page.getByRole("button", { name: "Add temporary meeting", exact: true }).click();
  await page.getByRole("button", { name: "Rename General Voice", exact: true }).click();
  await page.getByLabel("New meeting name", { exact: true }).fill("Lounge");
  await page.getByRole("button", { name: "Save meeting name", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rename Lounge", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rename Lounge", exact: true }).click();
  await page.getByLabel("New meeting name", { exact: true }).fill("Design Room");
  await page.getByRole("button", { name: "Save meeting name", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("already in your list");
  await page.getByRole("button", { name: "Cancel rename", exact: true }).click();
  if (test.info().project.name === "chromium") { await page.setViewportSize({ width: 1280, height: 787 }); await page.screenshot({ path: "docs/screenshots/meetings-manage.png" }); }
  await page.getByRole("button", { name: "Remove Lounge", exact: true }).click();
  await page.getByRole("button", { name: "Remove temporary meeting", exact: true }).click();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await expect(sidebar(page).getByRole("button", { name: "Join Lounge", exact: true })).toHaveCount(0);
  await expect(sidebar(page).getByRole("button", { name: "Join Design Room", exact: true })).toBeVisible();
  await page.reload();
  await expect(join(page)).toHaveCount(0);
  await manageTemporary(page);
  await page.getByRole("button", { name: "Remove Design Room", exact: true }).click();
  await page.getByRole("button", { name: "Remove temporary meeting", exact: true }).click();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await expect(page.getByText("Start a meeting to talk, share a screen, or work through something together.")).toBeVisible();
  await page.reload();
  await expect(join(page)).toHaveCount(0);
});
test("keeps the native room conversation available after failed voice and isolates room destinations", async ({ page }) => {
  await page.goto(`${fixture}?deny`);
  const conversation = page.getByRole("region", { name: "Native conversation" });
  await expect(conversation).toHaveAttribute("data-channel", general);
  await page.getByRole("textbox", { name: "Room message" }).fill("Notes for General Voice");
  await page.getByRole("textbox", { name: "Room message" }).press("Enter");
  await expect(conversation).toContainText("Notes for General Voice");
  await join(page).click();
  await expect(page.getByRole("alert")).toContainText("Microphone permission was denied");
  await expect(conversation).toContainText("Notes for General Voice");
  await addTemporary(page, "Design");
  await sidebar(page).getByRole("button", { name: "Join Design", exact: true }).click();
  await expect(conversation).toHaveAttribute("data-channel", design);
  await expect(conversation).not.toContainText("Notes for General Voice");
  await page.getByRole("button", { name: "Close side panel", exact: true }).click();
  await expect(conversation).toHaveCount(0);
});
test("cancels a pending microphone prompt without leaking a late capture", async ({ page }) => {
  await page.goto(`${fixture}?hold`); await join(page).click();
  await controls(page).getByRole("button", { name: "Leave room" }).click();
  await page.evaluate(() => meetingTest.releaseMicrophone());
  await expect.poll(() => page.evaluate(() => meetingTest.microphoneStates())).toEqual(["ended"]);
  await expect(page.getByRole("status")).toHaveCount(0);
});

const workspaces = page => page.getByRole("navigation", { name: "Meetings", exact: true });
const workspace = page => page.getByRole("region", { name: "Persistent workspace", exact: true });
async function linkGeneral(page) {
  await page.getByRole("button", { name: "Save as shared workspace", exact: true }).click();
  await expect(page.getByLabel("Workspace channel")).toHaveValue(general);
  await page.getByRole("button", { name: "Link workspace", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rename workspace General Voice", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await expect(workspace(page).getByRole("heading", { name: "General Voice", exact: true })).toBeVisible();
}
test("shares persistent workspace notes, messages and stable identity across independent clients and restart", async ({ page, browser }, info) => {
  const realm = `shared-${info.project.name}`, other = await browser.newContext(), second = await other.newPage();
  try {
    await Promise.all([page.goto(`${fixture}?realm=${realm}&viewer=Alex`), second.goto(`${fixture}?realm=${realm}&viewer=Riley`)]);
    await linkGeneral(page);
    await expect(workspaces(second).getByRole("button", { name: "General Voice", exact: true })).toBeVisible();
    await workspaces(second).getByRole("button", { name: "General Voice", exact: true }).click();
    await expect(second.getByLabel("Shared notes")).toBeVisible();
    await page.getByLabel("Shared notes").fill("Agenda: retain the design rationale and decisions.");
    await page.getByRole("button", { name: "Save notes", exact: true }).click();
    await expect.poll(() => second.evaluate(() => meetingTest.workspaceState().canvases["10000000-0000-4000-8000-000000000001"]?.content)).toBe("Agenda: retain the design rationale and decisions.");
    await expect(second.getByLabel("Shared notes")).toHaveValue("");
    await second.getByRole("button", { name: "Load current notes", exact: true }).click();
    await expect(second.getByLabel("Shared notes")).toHaveValue("Agenda: retain the design rationale and decisions.");
    for (const client of [page, second]) await client.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Room message" }).fill("Reference file: https://example.com/design.pdf");
    await page.getByRole("textbox", { name: "Room message" }).press("Enter");
    await expect(second.getByRole("region", { name: "Native conversation" })).toContainText("https://example.com/design.pdf");
    await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
    await page.getByRole("button", { name: "Rename workspace General Voice", exact: true }).click();
    await page.getByLabel("New workspace name").fill("Planning");
    await page.getByRole("button", { name: "Save workspace name", exact: true }).click();
    await expect(workspace(second).locator(":scope > header").getByRole("heading", { name: "Planning", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Meetings", exact: true }).click();
    await Promise.all([page.reload(), second.reload()]);
    for (const client of [page, second]) {
      await expect(workspace(client).locator(":scope > header").getByRole("heading", { name: "Planning", exact: true })).toBeVisible();
      await expect(client.getByRole("region", { name: "Native Canvas" })).toHaveAttribute("data-channel", general);
      await expect(client.getByLabel("Shared notes")).toHaveValue("Agenda: retain the design rationale and decisions.");
      await client.getByRole("button", { name: "Chat", exact: true }).click();
      await expect(client.getByRole("region", { name: "Native conversation" })).toContainText("https://example.com/design.pdf");
      expect(await client.evaluate(() => meetingTest.microphoneRequests())).toBe(0);
    }
    const evidence = await page.evaluate(() => meetingTest.workspaceControl({}));
    expect(evidence.events).toHaveLength(1); expect(evidence.publications).toHaveLength(1);
    expect(evidence.events[0].tags).toContainEqual(["h", general]);
    if (info.project.name === "chromium") { await library(page, "Notes"); await page.screenshot({ path: "docs/screenshots/meetings-workspace.png", fullPage: true }); }
  } finally { await other.close(); }
});

test("honors read-only guests and revocation while keeping conflicting notes drafts", async ({ page, browser }, info) => {
  const realm = `access-${info.project.name}`, other = await browser.newContext(), second = await other.newPage();
  try {
    await Promise.all([page.goto(`${fixture}?realm=${realm}&viewer=Alex`), second.goto(`${fixture}?realm=${realm}&viewer=Riley`)]);
    await linkGeneral(page); await workspaces(second).getByRole("button", { name: "General Voice", exact: true }).click();
    await page.getByLabel("Shared notes").fill("First decision"); await page.getByRole("button", { name: "Save notes", exact: true }).click();
    await expect.poll(() => second.evaluate(() => meetingTest.workspaceState().canvases["10000000-0000-4000-8000-000000000001"]?.content)).toBe("First decision");
    await second.getByRole("button", { name: "Load current notes", exact: true }).click();
    await expect(second.getByLabel("Shared notes")).toHaveValue("First decision");
    await second.getByLabel("Shared notes").fill("Riley’s pending edit");
    await page.getByLabel("Shared notes").fill("Alex’s newer decision"); await page.getByRole("button", { name: "Save notes", exact: true }).click();
    await expect.poll(() => second.evaluate(() => meetingTest.workspaceState().canvases["10000000-0000-4000-8000-000000000001"].content)).toBe("Alex’s newer decision");
    await second.getByRole("button", { name: "Save notes", exact: true }).click();
    await expect(second.getByRole("alert")).toContainText("Canvas changed");
    await expect(second.getByLabel("Shared notes")).toHaveValue("Riley’s pending edit");
    await second.getByRole("button", { name: "Load current notes", exact: true }).click();
    await expect(second.getByLabel("Shared notes")).toHaveValue("Alex’s newer decision");
    await page.evaluate(({ id, viewer }) => meetingTest.workspaceControl({ grant: { id, viewer, role: "guest" } }), { id: general, viewer: identities.Riley });
    await expect(workspace(second).getByText("Read only", { exact: true })).toBeVisible();
    await expect(second.getByLabel("Shared notes")).toHaveAttribute("readonly", "");
    await expect(second.getByRole("button", { name: "Save notes", exact: true })).toBeDisabled();
    await second.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(second.getByRole("textbox", { name: "Room message" })).toBeDisabled();
    await page.evaluate(({ id, viewer }) => meetingTest.workspaceControl({ grant: { id, viewer, role: null } }), { id: general, viewer: identities.Riley });
    await expect(workspace(second)).toContainText("workspace is unavailable");
    await expect(second.getByRole("region", { name: "Native conversation" })).toHaveCount(0);
    await expect(workspaces(second).getByRole("button", { name: "General Voice", exact: true })).toHaveCount(0);
    await second.reload(); await expect(workspace(second)).toContainText("workspace is unavailable");
    expect(await second.evaluate(() => meetingTest.microphoneRequests())).toBe(0);
  } finally { await other.close(); }
});

for (const failure of ["before", "after"]) test(`recovers a link interrupted ${failure} delivery without a replacement or automatic retry`, async ({ page }, info) => {
  const realm = `recovery-${failure}-${info.project.name}`;
  await page.goto(`${fixture}?realm=${realm}`);
  await expect(page.getByRole("button", { name: "Save as shared workspace", exact: true })).toBeVisible();
  await page.evaluate(failPublish => meetingTest.workspaceControl({ failPublish }), failure);
  await page.getByRole("button", { name: "Save as shared workspace", exact: true }).click();
  await page.getByRole("button", { name: "Link workspace", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("unconfirmed");
  const original = await page.evaluate(() => meetingTest.workspaceControl({}));
  expect(original.publications).toHaveLength(1);
  await page.reload();
  await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check saved link", exact: true })).toBeVisible();
  let evidence = await page.evaluate(() => meetingTest.workspaceControl({})); expect(evidence.publications).toHaveLength(1);
  await page.evaluate(() => meetingTest.workspaceControl({ failPublish: "", failRead: false }));
  await page.getByRole("button", { name: "Check saved link", exact: true }).click();
  evidence = await page.evaluate(() => meetingTest.workspaceControl({})); expect(evidence.publications).toHaveLength(1);
  if (failure === "before") {
    await expect(page.getByRole("alert")).toContainText("still unconfirmed");
    await page.getByRole("button", { name: "Retry saved link", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: "Check saved link", exact: true })).toHaveCount(0);
  evidence = await page.evaluate(() => meetingTest.workspaceControl({}));
  expect(evidence.events).toHaveLength(1); expect(evidence.creations).toHaveLength(0);
  expect(evidence.publications).toHaveLength(failure === "before" ? 2 : 1);
  for (const publication of evidence.publications) expect(publication).toEqual(original.publications[0]);
  expect(await page.evaluate(() => meetingTest.microphoneRequests())).toBe(0);
});
test("finishes a new private workspace after restart without creating another channel", async ({ page, browser }, info) => {
  const realm = `create-recovery-${info.project.name}`, other = await browser.newContext(), second = await other.newPage();
  try {
    await Promise.all([page.goto(`${fixture}?realm=${realm}&viewer=Alex`), second.goto(`${fixture}?realm=${realm}&viewer=Riley`)]);
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await page.evaluate(() => meetingTest.workspaceControl({ failPublish: "before" }));
    await page.getByLabel("Workspace name", { exact: true }).fill("Private planning");
    await expect(page.getByRole("combobox", { name: /^Visibility/ })).toHaveValue("private");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("unconfirmed");
    await expect(page.getByRole("button", { name: "Finish workspace link", exact: true })).toBeVisible();
    const original = await page.evaluate(() => meetingTest.workspaceControl({}));
    expect(original.creations).toHaveLength(1); expect(original.publications).toHaveLength(1);
    expect(original.creations[0].visibility).toBe("private");
    expect(original.creations[0]).not.toHaveProperty("ttlSeconds");
    const id = original.creations[0].id;
    await page.reload();
    await page.getByRole("button", { name: "Manage workspaces", exact: true }).click();
    await expect(page.getByRole("button", { name: "Finish workspace link", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create workspace", exact: true })).toBeDisabled();
    let evidence = await page.evaluate(() => meetingTest.workspaceControl({ failPublish: "" }));
    expect(evidence.creations).toHaveLength(1); expect(evidence.publications).toHaveLength(1);
    await page.getByRole("button", { name: "Finish workspace link", exact: true }).click();
    await expect(page.getByRole("button", { name: "Finish workspace link", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rename workspace Private planning", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Meetings", exact: true }).click();
    await expect(page.getByRole("region", { name: "Native Canvas" })).toHaveAttribute("data-channel", id);
    evidence = await page.evaluate(() => meetingTest.workspaceControl({}));
    expect(evidence.creations).toHaveLength(1); expect(evidence.events).toHaveLength(1); expect(evidence.publications).toHaveLength(2);
    expect(evidence.publications[1]).toEqual(original.publications[0]);
    expect(evidence.events[0].tags).toContainEqual(["h", id]);
    await expect(workspaces(second).getByRole("button", { name: "Private planning", exact: true })).toHaveCount(0);
    await second.evaluate(id => meetingTest.navigate({ kind: "page", route: { params: { workspace: id } } }), id);
    await expect(workspace(second)).toContainText("workspace is unavailable");
    expect(await page.evaluate(() => meetingTest.microphoneRequests())).toBe(0);
    expect(await second.evaluate(() => meetingTest.microphoneRequests())).toBe(0);
  } finally { await other.close(); }
});
test("cancels stalled device requests and rejoins without waiting for late capture", async ({ page }, info) => {
  test.skip(!upstream, "Requires the real SFU and Rust broker");
  await page.addInitScript(() => Object.defineProperty(navigator, "platform", { value: "MacIntel" }));
  await page.goto(`${fixture}?viewer=Alex&realm=capture-recovery`);
  const room = `Capture recovery ${info.project.name}`;
  await addTemporary(page, room);
  const joinRecovery = sidebar(page).getByRole("button", { name: `Join ${room}`, exact: true });
  await joinRecovery.click();
  await expect(controls(page).getByRole("status")).toHaveText("Voice connected", { timeout: 15000 });
  await page.evaluate(() => meetingTest.holdCamera());
  await controls(page).getByRole("button", { name: "Camera on", exact: true }).click();
  await expect(controls(page).getByRole("button", { name: "Cancel camera", exact: true })).toBeVisible();
  await controls(page).getByRole("button", { name: "Leave room", exact: true }).click();
  await joinRecovery.click();
  await expect(controls(page).getByRole("status")).toHaveText("Voice connected", { timeout: 15000 });
  await page.evaluate(() => meetingTest.releaseCamera());
  await expect.poll(() => page.evaluate(() => meetingTest.cameraStates())).toEqual(["ended"]);
  await expect(controls(page).getByRole("button", { name: "Camera on", exact: true })).toBeVisible();
  await page.evaluate(() => meetingTest.holdScreen());
  await startShare(page);
  await expect(page.getByRole("button", { name: "Choosing screen…", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel screen share", exact: true }).click();
  await expect(page.getByRole("button", { name: "Share screen", exact: true })).toBeEnabled();
  await page.evaluate(() => meetingTest.releaseScreen());
  await expect.poll(() => page.evaluate(() => meetingTest.captureStates())).toEqual(["ended"]);
  await expect(controls(page).getByRole("status")).toHaveText("Voice connected");
  await page.evaluate(() => meetingTest.denyNextCamera());
  await controls(page).getByRole("button", { name: "Camera on", exact: true }).click();
  const cameraHelp = page.getByRole("group", { name: "Camera permissions", exact: true });
  await expect(cameraHelp).toBeVisible();
  await cameraHelp.getByRole("button", { name: "Open camera settings", exact: true }).click();
  expect(await page.evaluate(() => meetingTest.cameraSettingsCommands())).toEqual(["camera-settings-macos"]);
  await expect(cameraHelp.getByRole("alert")).toContainText("open them manually");
  await cameraHelp.getByRole("button", { name: "Try camera again", exact: true }).click();
  await expect(controls(page).getByRole("button", { name: "Camera off", exact: true })).toBeVisible();
  await expect(cameraHelp).toHaveCount(0);
  await controls(page).getByRole("button", { name: "Camera off", exact: true }).click();
  await controls(page).getByRole("button", { name: "Leave room", exact: true }).click();
  expect(await page.evaluate(() => meetingTest.microphoneStates())).toEqual(["ended", "ended"]);
});

test("joins voice in one click, hears peers, mutes, watches simultaneous screens and tears down", async ({ page, context }) => {
  test.skip(!upstream, "Run npm run test:media to exercise the real SFU and Rust broker"); test.setTimeout(120000);
  const first = await context.newPage(), second = await context.newPage();
  await Promise.all([first.goto(`${fixture}?viewer=Alex`), second.goto(`${fixture}?viewer=Riley`), page.goto(`${fixture}?viewer=Sam`)]);
  for (const client of [first, second, page]) { await join(client).click(); await expect(controls(client).getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible({ timeout: 15000 }); }
  const roster = sidebar(page).getByRole("list", { name: "Connected participants" });
  await expect(roster.getByRole("listitem")).toHaveCount(3);
  await expect(roster).toContainText("Sam (you)");
  await linkGeneral(first);
  expect(await first.evaluate(() => meetingTest.microphoneStates())).toEqual(["live"]);
  await join(first).click();
  await expect(stage(first)).toBeVisible();
  await expect(workspace(first)).toHaveCount(0);
  expect(await first.evaluate(() => meetingTest.microphoneStates())).toEqual(["live"]);
  await expect.poll(() => page.locator("audio[data-meeting-audio]").count()).toBe(2);
  await expect.poll(() => page.locator("audio[data-meeting-audio]").first().evaluate(element => element.currentTime)).toBeGreaterThan(0);
  await controls(first).getByRole("button", { name: "Mute", exact: true }).click();
  await expect(sidebar(second).getByRole("listitem").filter({ hasText: "Alex" })).toContainText("Muted");
  await controls(first).getByRole("button", { name: "Unmute", exact: true }).click();
  await controls(page).getByRole("button", { name: "Deafen", exact: true }).click();
  await expect.poll(() => page.locator("audio[data-meeting-audio]").evaluateAll(elements => elements.every(element => element.muted))).toBe(true);
  await expect(controls(page).getByRole("button", { name: "Unmute", exact: true })).toBeDisabled();
  await controls(page).getByRole("button", { name: "Undeafen", exact: true }).click();
  await controls(page).getByRole("button", { name: "Unmute", exact: true }).click();
  await controls(first).getByRole("button", { name: "Camera on", exact: true }).click();
  await playback(second.getByLabel("Alex’s camera", { exact: true }));
  await sidebar(second).getByRole("button", { name: "Show Alex on stage", exact: true }).click();
  await playback(second.getByLabel("Alex’s camera on stage", { exact: true }));
  await controls(first).getByRole("button", { name: "Camera off", exact: true }).click();
  await expect(second.getByLabel("Alex’s camera", { exact: true })).toHaveCount(0);
  await expect(second.getByRole("button", { name: "Back to participants", exact: true })).toBeVisible();
  await second.getByRole("button", { name: "Back to participants", exact: true }).click();
  await first.evaluate(() => meetingTest.cancelNextCapture());
  await startShare(first);
  await expect(first.getByRole("alert")).toContainText("Screen selection canceled");
  for (const client of [first, second]) await startShare(client);
  await expect(page.getByRole("button", { name: "Watch Alex’s stream" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Watch Riley’s stream" })).toBeVisible();
  await first.getByRole("button", { name: "Show your screen on stage", exact: true }).click();
  await playback(first.getByLabel("Your screen on stage", { exact: true }));
  await expect(stage(page).getByRole("list", { name: "Meeting participants", exact: true })).toBeVisible();
  await first.getByRole("button", { name: "Show your screen on stage", exact: true }).click();
  await expect(first.getByLabel("Your screen on stage", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Watch Alex’s stream" }).click(); await playback(video(page));
  for (const client of [first, second]) {
    const close = client.getByRole("button", { name: "Close sharing options", exact: true });
    if (await close.isVisible()) await close.click();
  }
  await first.getByRole("button", { name: "Change source" }).click();
  await expect(first.getByText("Window 2 · Your screen")).toBeVisible();
  await page.getByRole("button", { name: "Watch all screens" }).click();
  await playback(page.getByLabel("Alex’s screen", { exact: true })); await playback(page.getByLabel("Riley’s screen", { exact: true }));
  await page.getByRole("button", { name: "Focus Alex’s screen", exact: true }).click();
  await playback(video(page));
  await page.getByRole("button", { name: "Watch all screens", exact: true }).click();
  if (test.info().project.name === "chromium") await page.screenshot({ path: "docs/screenshots/meetings.png", fullPage: true });
  await first.getByRole("button", { name: "Messages", exact: true }).click();
  await expect(first.getByRole("toolbar", { name: "Buzz toolbar" }).getByRole("button", { name: "Leave room" })).toBeVisible();
  expect(await first.evaluate(() => meetingTest.microphoneStates())).toEqual(["live"]);
  expect(await first.evaluate(() => meetingTest.captureStates())).toEqual(["ended", "live"]);
  await first.getByRole("toolbar", { name: "Buzz toolbar" }).getByRole("button", { name: "Leave room" }).click();
  await expect(roster.getByRole("listitem")).toHaveCount(2);
  expect(await first.evaluate(() => meetingTest.microphoneStates())).toEqual(["ended"]);
  expect(await first.evaluate(() => meetingTest.captureStates())).toEqual(["ended", "ended"]);
  await addTemporary(page, "Design");
  await sidebar(page).getByRole("button", { name: "Join Design", exact: true }).click();
  await expect(stage(page).getByRole("heading", { name: "Design", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => meetingTest.microphoneStates())).toEqual(["ended", "live"]);
  await expect(sidebar(second).getByRole("listitem")).toHaveCount(1);
  await second.evaluate(() => meetingTest.switchCommunity());
  expect(await second.evaluate(() => meetingTest.microphoneStates())).toEqual(["ended"]);
  expect(await second.evaluate(() => meetingTest.captureStates())).toEqual(["ended"]);
  await expect(sidebar(page).getByRole("list", { name: "Connected participants" }).getByRole("listitem")).toHaveCount(1);
  await page.evaluate(() => meetingTest.disable());
  expect(await page.evaluate(() => meetingTest.microphoneStates())).toEqual(["ended", "ended"]);
  await expect(page.locator("audio[data-meeting-audio]")).toHaveCount(0);
});

// Workspace admission needs a relay-backed broker identity. Forward the client's
// workspace requests as trusted-proxy meeting requests to the real broker, so the
// SFU, speech worker and plugin run for real while channel verification is a fixture.
async function proxyWorkspaceVoice(page) {
  const serviceIdentity = "e".repeat(64);
  await page.routeWebSocket(/\/rooms$/, socket => {
    let server;
    socket.onMessage(raw => {
      const request = JSON.parse(raw);
      if (request.type === "service") return socket.send(JSON.stringify({ type: "service", workspaceVoice: true, identity: serviceIdentity, community: new URL(fixture).origin, presence: true }));
      if (!server) { server = socket.connectToServer(); server.onMessage(message => socket.send(message)); }
      if (request.type === "workspace" && request.presence) return server.send(JSON.stringify({ type: "presence", community: new URL(request.community).origin + "/", room: `workspace ${request.channel}`.slice(0, 64) }));
      if (request.type === "workspace") {
        const { name, community, channel, picture, captions } = request;
        return server.send(JSON.stringify({ type: captions ? "captions" : "meeting", name, community: new URL(community).origin + "/", room: `workspace ${channel}`.slice(0, 64), ...(picture ? { picture } : {}) }));
      }
      server.send(raw);
    });
  });
}
test("keeps a workspace transcript recoverable after leaving and rejoining, and only treats it as saved when a record covers it", async ({ page }, info) => {
  test.skip(!upstream || !process.env.BUZZ_TEST_LIVE_SPEECH, "Enable real speech recognition for the ended-call transcript");
  test.setTimeout(180000);
  await proxyWorkspaceVoice(page);
  await page.goto(`${fixture}?realm=ended-${info.project.name}&speech&viewer=Alex`);
  await linkGeneral(page);
  const view = workspace(page), tabs = view.getByRole("group", { name: "Workspace views" }), callbar = view.getByRole("group", { name: "Meeting controls" });
  await view.getByRole("button", { name: "Enable voice & join", exact: true }).click();
  await expect(callbar.getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible({ timeout: 15000 });
  await callbar.getByRole("button", { name: "Transcript", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Meeting transcript", exact: true });
  const entries = panel.getByRole("region", { name: "Transcript entries" }).getByRole("listitem");
  await expect.poll(() => entries.count(), { timeout: 45000 }).toBeGreaterThan(0);
  // Save mid-call, then keep talking: the later speech is not covered by that save.
  await panel.getByRole("button", { name: "Save meeting record", exact: true }).click();
  await expect(panel).toContainText("Saved in this workspace’s Meeting records.", { timeout: 15000 });
  const savedCount = await entries.count();
  await expect.poll(() => entries.count(), { timeout: 45000 }).toBeGreaterThan(savedCount);
  await expect(panel).not.toContainText("Saved in this workspace’s Meeting records.");
  // Leave while viewing the transcript.
  await callbar.getByRole("button", { name: "Leave room", exact: true }).click();
  const ended = view.getByRole("group", { name: "Ended call" });
  await expect(ended.getByRole("status")).toHaveText("The call ended. Its transcript isn’t saved yet.");
  const spoken = await entries.count();
  expect(spoken).toBeGreaterThan(savedCount);
  // Rename the workspace meanwhile: the record must still bind to the original channel.
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await page.getByRole("button", { name: "Rename workspace General Voice", exact: true }).click();
  await page.getByLabel("New workspace name").fill("Playtest review");
  await page.getByRole("button", { name: "Save workspace name", exact: true }).click();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await workspaces(page).getByRole("button", { name: "Playtest review", exact: true }).click();
  // Rejoining keeps the earlier transcript.
  await view.getByRole("button", { name: "Join voice", exact: true }).click();
  await expect(callbar.getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible({ timeout: 15000 });
  await expect(ended.getByRole("status")).toHaveText("An earlier call’s transcript isn’t saved yet.");
  await ended.getByRole("button", { name: "Review and save", exact: true }).click();
  await expect(entries).toHaveCount(spoken);
  await panel.getByRole("button", { name: "Save meeting record", exact: true }).click();
  await expect(ended.getByRole("status")).toHaveText("An earlier call’s transcript is saved in Meeting records.", { timeout: 15000 });
  const evidence = await page.evaluate(() => meetingTest.workspaceControl({}));
  const saved = evidence.events.filter(event => event.tags.some(tag => tag[0] === "type" && tag[1] === "studio.h2s2.meetings.record")).map(event => ({ tags: event.tags, value: JSON.parse(event.content) }));
  expect(saved).toHaveLength(2);
  for (const record of saved) { expect(record.tags).toContainEqual(["h", general]); expect(record.value.callId).toMatch(/^RM_/); }
  expect(saved.map(record => record.value.covers.count).sort((a, b) => a - b)).toEqual([savedCount, spoken]);
  await library(view, "Meeting records");
  await expect(view.getByRole("region", { name: "Saved meeting records" }).getByRole("button")).toHaveCount(2);
  await ended.getByRole("button", { name: "Close transcript", exact: true }).click();
  await expect(ended).toHaveCount(0);
  await callbar.getByRole("button", { name: "Leave room", exact: true }).click();
});
test("keeps an earlier temporary-meeting transcript reviewable after rejoining, then discards it", async ({ page }, info) => {
  test.skip(!upstream || !process.env.BUZZ_TEST_LIVE_SPEECH, "Enable real speech recognition for the retained transcript");
  test.setTimeout(120000);
  await page.goto(`${fixture}?realm=retained-${info.project.name}&speech&no-agent-runtime&viewer=Alex`);
  const room = `Retained ${info.project.name}`;
  await addTemporary(page, room);
  const row = sidebar(page).getByRole("button", { name: `Join ${room}`, exact: true });
  await row.click();
  await expect(controls(page).getByRole("status")).toHaveText("Voice connected", { timeout: 15000 });
  await rail(page, "Transcript");
  const panel = page.getByRole("complementary", { name: "Meeting transcript", exact: true });
  const entries = panel.getByRole("region", { name: "Transcript entries" }).getByRole("listitem");
  await expect.poll(() => entries.count(), { timeout: 45000 }).toBeGreaterThan(0);
  await controls(page).getByRole("button", { name: "Leave room", exact: true }).click();
  const spoken = await entries.count();
  await row.click();
  await expect(controls(page).getByRole("status")).toHaveText("Voice connected", { timeout: 15000 });
  const earlier = panel.getByRole("group", { name: "Earlier transcript" });
  await expect(earlier.getByRole("status")).toHaveText("An earlier call’s transcript isn’t saved yet.");
  await earlier.getByRole("button", { name: "Review earlier transcript", exact: true }).click();
  await expect(earlier.getByRole("status")).toHaveText("Reviewing an earlier call’s transcript. It isn’t saved yet.");
  await expect(entries).toHaveCount(spoken);
  await panel.getByRole("button", { name: "Discard transcript", exact: true }).click();
  await panel.getByRole("button", { name: "Confirm discard", exact: true }).click();
  await expect(earlier).toHaveCount(0);
  await controls(page).getByRole("button", { name: "Leave room", exact: true }).click();
});
test("shows who is in a workspace call before joining, with an audio check and no microphone request", async ({ page, browser }, info) => {
  test.skip(!upstream, "Run npm run test:media to exercise the real SFU and Rust broker"); test.setTimeout(90000);
  const realm = `overview-${info.project.name}`, other = await browser.newContext({ permissions: ["microphone", "camera"] }), riley = await other.newPage();
  try {
    for (const client of [page, riley]) await proxyWorkspaceVoice(client);
    await Promise.all([page.goto(`${fixture}?realm=${realm}&viewer=Alex`), riley.goto(`${fixture}?realm=${realm}&viewer=Riley`)]);
    await linkGeneral(page);
    const view = workspace(page);
    await expect(view.getByRole("group", { name: "Workspace views" }).getByRole("button", { name: "Home", exact: true })).toHaveAttribute("aria-pressed", "true");
    // Before voice is enabled nothing is known, so the Overview does not claim the call is empty.
    await expect(view.getByRole("heading", { name: "Who’s in the call" })).toBeVisible({ timeout: 15000 });
    await view.getByRole("button", { name: "Enable voice & join", exact: true }).click();
    await expect(view.getByRole("group", { name: "Meeting controls" }).getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible({ timeout: 15000 });
    await view.getByRole("group", { name: "Meeting controls" }).getByRole("button", { name: "Leave room", exact: true }).click();
    await workspaces(riley).getByRole("button", { name: "General Voice", exact: true }).click();
    const rileyView = workspace(riley);
    await rileyView.getByRole("button", { name: "Join voice", exact: true }).click();
    await expect(rileyView.getByRole("group", { name: "Meeting controls" }).getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible({ timeout: 15000 });
    await view.getByRole("group", { name: "Workspace views" }).getByRole("button", { name: "Home", exact: true }).click();
    await expect(view.getByRole("heading", { name: "A call is in progress" })).toBeVisible({ timeout: 30000 });
    await expect(view.getByRole("region", { name: "In the call" })).toContainText("Riley");
    await expect(view.getByRole("status").filter({ hasText: /updated (just now|\d+ s ago)/ })).toBeVisible();
    const join = view.getByRole("complementary", { name: "Ready to join" });
    await expect(join.getByRole("region", { name: "Audio check" }).getByLabel("Join with microphone muted")).toBeVisible();
    await expect(join.getByRole("button", { name: "Join voice", exact: true })).toBeEnabled();
    await expect(view.getByRole("region", { name: "Agenda" }).getByLabel("Shared notes")).toBeVisible();
    expect(await page.evaluate(() => meetingTest.microphoneRequests())).toBe(1);
    if (info.project.name === "chromium") await page.screenshot({ path: "docs/screenshots/meetings-overview.png" });
  } finally { await other.close(); }
});
test("edits a document beside the live stage, then reopens it from the meeting record as presented and current", async ({ page }, info) => {
  test.skip(!upstream || !process.env.BUZZ_TEST_LIVE_SPEECH, "Enable real speech recognition to save the meeting record");
  test.setTimeout(150000);
  await proxyWorkspaceVoice(page);
  // Record cards only reference documents from a store that survives restarts.
  await page.goto(`${fixture}?realm=docs-call-${info.project.name}&speech&durable-documents&viewer=Alex`);
  await linkGeneral(page);
  const view = workspace(page), tabs = view.getByRole("group", { name: "Workspace views" }), callbar = view.getByRole("group", { name: "Meeting controls" });
  await view.getByRole("button", { name: "Enable voice & join", exact: true }).click();
  await expect(callbar.getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible({ timeout: 15000 });
  const edit = callbar.getByRole("button", { name: "Edit together", exact: true });
  await expect(edit).toBeEnabled(); await expect(edit).toHaveAttribute("aria-pressed", "false");
  await edit.click();
  const pane = view.getByRole("complementary", { name: "Edit together" });
  await pane.getByRole("button", { name: "New document", exact: true }).click();
  await pane.getByLabel("Document title", { exact: true }).fill("Turn 3 playtest brief"); await pane.getByLabel("Document title", { exact: true }).blur();
  await pane.getByLabel("Paragraph 1", { exact: true }).fill("The braking marker sits behind the bridge shadow.");
  await expect(pane.getByRole("status").filter({ hasText: "Saved · revision 3" })).toBeVisible();
  // The stage and controls stay live beside the editor.
  await expect(edit).toHaveAttribute("aria-pressed", "true");
  await expect(callbar.getByRole("button", { name: "Leave room", exact: true })).toBeVisible();
  if (info.project.name === "chromium") await page.screenshot({ path: "docs/screenshots/meetings-edit-together.png" });
  await callbar.getByRole("button", { name: "Transcript", exact: true }).click();
  const transcript = page.getByRole("complementary", { name: "Meeting transcript", exact: true });
  await expect.poll(() => transcript.getByRole("region", { name: "Transcript entries" }).getByRole("listitem").count(), { timeout: 45000 }).toBeGreaterThan(0);
  // A later edit after the record is saved: "As presented" stays at the saved revision.
  await transcript.getByRole("button", { name: "Save meeting record", exact: true }).click();
  await expect(transcript).toContainText("Saved in this workspace’s Meeting records.", { timeout: 15000 });
  await tabs.getByRole("button", { name: "Call", exact: true }).click();
  await pane.getByLabel("Paragraph 1", { exact: true }).fill("Move the marker out of the shadow.");
  await expect(pane.getByRole("status").filter({ hasText: "Saved · revision 4" })).toBeVisible();
  await callbar.getByRole("button", { name: "Leave room", exact: true }).click();
  await library(view, "Meeting records");
  const records = view.getByRole("region", { name: "Saved meeting records" });
  await records.getByRole("button", { name: /General Voice/ }).click();
  const made = records.getByRole("region", { name: "Made in this meeting" });
  await expect(made).toContainText("Turn 3 playtest brief");
  await made.getByRole("button", { name: "As presented (rev 3)", exact: true }).click();
  const presented = view.getByRole("region", { name: "Document: Turn 3 playtest brief" });
  await expect(presented.getByRole("status").filter({ hasText: "As presented · revision 3" })).toBeVisible();
  await expect(presented).toContainText("The braking marker sits behind the bridge shadow.");
  await presented.getByRole("button", { name: "Open current", exact: true }).click();
  await expect(presented.getByLabel("Paragraph 1", { exact: true })).toHaveValue("Move the marker out of the shadow.");
});
test("keeps a same-name quick room and workspace distinct across selection, rename and return from Messages", async ({ page }, info) => {
  test.skip(!upstream, "Run npm run test:media to exercise the real SFU and Rust broker"); test.setTimeout(90000);
  await proxyWorkspaceVoice(page);
  await page.goto(`${fixture}?realm=same-name-${info.project.name}&viewer=Alex`);
  await linkGeneral(page);
  const view = workspace(page), callbar = view.getByRole("group", { name: "Meeting controls" });
  await view.getByRole("button", { name: "Enable voice & join", exact: true }).click();
  await expect(callbar.getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible({ timeout: 15000 });
  const quick = sidebar(page).getByRole("button", { name: "Join General Voice", exact: true });
  // One roster, under the workspace row; the same-name temporary row stays idle.
  const quickRoster = quick.locator("xpath=..").getByRole("list", { name: "Connected participants" });
  await expect(sidebar(page).getByRole("list", { name: "Connected participants" })).toHaveCount(1);
  await expect(quickRoster).toHaveCount(0);
  await expect(quick).not.toHaveAttribute("aria-current", "true");
  await expect(quick).toContainText("Temporary");
  // Return from Messages lands on the workspace call, not the same-name quick room.
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByRole("toolbar", { name: "Buzz toolbar" }).getByRole("button", { name: "General Voice", exact: true }).click();
  await expect(view.getByRole("group", { name: "Workspace views" }).getByRole("button", { name: "Call", exact: true })).toHaveAttribute("aria-pressed", "true");
  // Renaming the quick shortcut never leaves the workspace call.
  await manageTemporary(page);
  await page.getByRole("button", { name: "Rename General Voice", exact: true }).click();
  await page.getByLabel("New meeting name", { exact: true }).fill("Lounge");
  await expect(page.getByRole("button", { name: "Save meeting name", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save meeting name", exact: true }).click();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await workspaces(page).getByRole("button", { name: "General Voice", exact: true }).click();
  await expect(callbar.getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible();
  await manageTemporary(page);
  await page.getByRole("button", { name: "Rename Lounge", exact: true }).click();
  await page.getByLabel("New meeting name", { exact: true }).fill("General Voice");
  await page.getByRole("button", { name: "Save meeting name", exact: true }).click();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  // Selecting the quick room joins it instead of reusing the workspace connection.
  const occurrence = await view.getByRole("group", { name: "Meeting controls" }).getAttribute("data-occurrence");
  await quick.click();
  await expect(controls(page).getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible({ timeout: 15000 });
  await expect(quick).toHaveAttribute("aria-current", "true");
  await expect(quickRoster).toHaveCount(1);
  await expect(sidebar(page).getByRole("list", { name: "Connected participants" })).toHaveCount(1);
  await expect(controls(page)).not.toHaveAttribute("data-occurrence", occurrence);
});
test("identifies a call occurrence by its media room across rejoin and replaces it after the room empties", async ({ page, context }, info) => {
  test.skip(!upstream, "Run npm run test:media to exercise the real SFU and Rust broker"); test.setTimeout(90000);
  const other = await context.newPage();
  await Promise.all([page.goto(`${fixture}?viewer=Alex`), other.goto(`${fixture}?viewer=Riley`)]);
  // A room of its own: a page closed mid-call elsewhere keeps a shared room alive until LiveKit times it out.
  const roomName = `Occurrence ${info.project.name} ${Date.now() % 100000}`;
  for (const client of [page, other]) {
    await addTemporary(client, roomName);
  }
  const room = client => sidebar(client).getByRole("button", { name: `Join ${roomName}`, exact: true });
  const occurrence = async client => { await expect(controls(client)).toHaveAttribute("data-occurrence", /^RM_[A-Za-z0-9]+$/, { timeout: 15000 }); return controls(client).getAttribute("data-occurrence"); };
  const connect = async client => { await room(client).click(); await expect(controls(client).getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible({ timeout: 15000 }); return occurrence(client); };
  const leave = async client => { await controls(client).getByRole("button", { name: "Leave room", exact: true }).click(); await expect(room(client)).toBeVisible(); };
  const first = await connect(page);
  expect(await connect(other)).toBe(first);
  await leave(other);
  expect(await connect(other)).toBe(first);
  await leave(page); await leave(other);
  // LiveKit keeps an emptied room for its 20 s departure timeout, then closes it.
  await page.waitForTimeout(25000);
  const next = await connect(page);
  expect(next).not.toBe(first);
  expect(await connect(other)).toBe(next);
});
test("keeps icon controls reachable and sharing choices explicit across pane sizes and navigation", async ({ page }) => {
  test.skip(!upstream, "Run npm run test:media to exercise call controls");
  await page.goto(`${fixture}?realm=ux-drawer`); await join(page).click();
  await expect(controls(page).getByRole("status")).toHaveText("Voice connected");
  const trigger = controls(page).getByRole("button", { name: "Share screen", exact: true });
  await trigger.focus(); await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Screen sharing", exact: true });
  await expect(drawer).toBeVisible();
  expect(await page.evaluate(() => meetingTest.captureStates())).toEqual([]);
  const box = await drawer.boundingBox(), anchor = await trigger.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(anchor.y);
  await drawer.getByLabel("Quality for next source").selectOption("sharp");
  await page.keyboard.press("Escape"); await expect(drawer).not.toBeVisible(); await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Close side panel", exact: true }).click();
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  const toolbar = page.getByRole("toolbar", { name: "Buzz toolbar" });
  await toolbar.getByRole("button", { name: "Share screen", exact: true }).click();
  await expect(drawer.getByLabel("Quality for next source")).toHaveValue("sharp");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open side panel", exact: true })).toBeVisible();
  for (const [width, root] of [[960,16], [530,16], [390,16], [1280,32]]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, root);
    await expect.poll(() => controls(page).locator(":scope > button, :scope > .meeting-sharing-trigger > button").evaluateAll(buttons => buttons.every(button => { const box = button.getBoundingClientRect(); return box.width > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; }))).toBe(true);
  }
  await controls(page).getByRole("button", { name: "Leave room", exact: true }).click();
});

test("assigns an agent task through native chat, reviews membership separately and reports real activity", async ({ page }, info) => {
  await page.goto(`${fixture}?realm=agent-flow-${info.project.name}&agents`);
  await rail(page, "Agent");
  const agents = page.getByRole("region", { name: "Meeting agents", exact: true });
  await page.evaluate(()=>meetingTest.setAgentRunning(false));
  await expect(agents.getByRole("button",{name:"Add Research helper to call",exact:true})).toHaveCount(0);
  await page.evaluate(()=>meetingTest.setAgentRunning(true));
  await expect(agents.getByRole("button",{name:"Add Research helper to call",exact:true})).toBeVisible();
  await agents.getByText("Send a written task", { exact: true }).click();
  await agents.getByLabel("Agent", { exact: true }).selectOption("d".repeat(64));
  await expect(agents.getByRole("button", { name: "Send task", exact: true })).toBeDisabled();
  await agents.getByRole("button", { name: "Manage access", exact: true }).click();
  expect((await page.evaluate(() => meetingTest.navigationTargets())).at(-1)).toMatchObject({ kind: "conversation", panel: "members", channelId: general });
  expect(await page.evaluate(() => meetingTest.taskRequests())).toEqual([]);
  await agents.getByLabel("Agent", { exact: true }).selectOption("b".repeat(64));
  await agents.getByLabel("Request", { exact: true }).fill("Find the open decisions and cite their messages.");
  await agents.getByRole("button", { name: "Send task", exact: true }).click();
  await expect(agents.getByRole("status")).toContainText("Task queued in Buzz");
  const requests = await page.evaluate(() => meetingTest.taskRequests());
  expect(requests).toEqual([{ channelId: general, text: "@Research helper\n\nFind the open decisions and cite their messages.", mentions: ["b".repeat(64)] }]);
  await expect(agents.getByLabel("Request", { exact: true })).toHaveValue("");
  await page.evaluate(channelId => meetingTest.setAgentActivity([{ agent: "b".repeat(64), channelId, messageId: "e".repeat(64), state: "working", startedAt: Date.now(), stoppable: true, evidence: null }]), general);
  await expect(agents).toContainText("Starting…");
  await page.evaluate(channelId => meetingTest.setAgentActivity([{ agent: "b".repeat(64), channelId, messageId: "e".repeat(64), state: "working", startedAt: Date.now(), stoppable: true, evidence: { lifecycle: {} } }]), general);
  await expect(agents).toContainText("Working");
  await agents.getByRole("button", { name: "Stop task", exact: true }).click();
  await expect(agents).toContainText("Stopped");
  await rail(page, "Chat");
  await expect(page.getByRole("region", { name: "Native conversation" })).toContainText("Find the open decisions");
  await rail(page, "Agent");
  await agents.getByText("Send a written task", { exact: true }).click();
  await page.evaluate(async input => meetingTest.workspaceControl(input), { grant: { id: general, viewer: identities.Alex, role: "guest" } });
  await expect(agents.getByRole("button", { name: "Send task", exact: true })).toBeDisabled();
});

test("delivers overlapping live speakers to an agent with timestamps and records tasks as the agent", async ({ page, context }) => {
  test.skip(!upstream || !process.env.BUZZ_TEST_LIVE_SPEECH, "Enable the local speech service for the real transcription workflow");
  test.setTimeout(90000);
  let speechConnections = 0;
  page.on("websocket", socket => socket.on("framesent", event => {
    try { if (["listen", "captions"].includes(JSON.parse(event.payload).type)) speechConnections++; } catch { /* Other host/media frames. */ }
  }));
  const other = await context.newPage();
  await Promise.all([page.goto(`${fixture}?realm=live-agent&agents&speech&viewer=Alex`), other.goto(`${fixture}?realm=live-agent&speech&viewer=Riley`)]);
  await join(page).click(); await join(other).click();
  await expect(controls(page).getByRole("status")).toHaveText("Voice connected");
  await expect(controls(other).getByRole("status")).toHaveText("Voice connected");
  await rail(page, "Transcript");
  await rail(page, "Agent");
  const panel = page.getByRole("region", { name: "Meeting agents", exact: true });
  await panel.getByRole("button", { name: "Add Research helper to call", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Listening · ready for spoken tasks", { timeout: 15000 });
  expect(speechConnections).toBe(1);
  await expect.poll(() => page.evaluate(() => meetingTest.agentWakes().length), { timeout: 45000 }).toBeGreaterThan(0);
  const wakes = await page.evaluate(() => meetingTest.agentWakes());
  const session_id = wakes[0].text.match(/session_id ([0-9a-f-]{36})/)[1];
  const read = () => page.evaluate(args => meetingTest.callAgentTool("meetings_live_context", args), { session_id });
  await expect.poll(async () => { const value = await read(); return [...new Set(value.transcript.map(segment => segment.speakerName))].sort(); }, { timeout: 45000 }).toEqual(["Alex", "Riley"]);
  const value = await read();
  expect(wakes[0].root).toBe(value.ownerRequestId);
  expect((await page.evaluate(() => meetingTest.taskRequests())).filter(request => request.text.includes("Live meeting session:")).length).toBe(1);
  expect(value.ownerEnabled.mode).toBe("act");
  const alex = value.transcript.find(segment => segment.speakerName === "Alex"), riley = value.transcript.find(segment => segment.speakerName === "Riley");
  expect(alex.speakerId).not.toBe(riley.speakerId);
  expect(Math.max(alex.startedAt, riley.startedAt)).toBeLessThan(Math.min(alex.endedAt, riley.endedAt));
  await expect(stage(other).getByRole("status").filter({ hasText: "Shared transcription active" })).toContainText("1 agent listening");
  expect(alex.text).toMatch(/research|questions|notes/i); expect(riley.text).toMatch(/design|review|Friday/i);
  for (const segment of [alex, riley]) { expect(segment.startedAt).toBeGreaterThan(Date.now() - 120000); expect(segment.endedAt).toBeGreaterThanOrEqual(segment.startedAt); }
  await expect(page.evaluate(args => meetingTest.callAgentTool("meetings_live_context", args, { client: { pubkey: "c".repeat(64) } }), { session_id })).rejects.toThrow("not available");
  await expect(page.evaluate(args => meetingTest.callAgentTool("meetings_live_context", args, { client: { key: "b".repeat(64) + "@another-community" } }), { session_id })).rejects.toThrow("not available");
  await expect(page.evaluate(args => meetingTest.callAgentTool("meetings_live_context", args, { context: { channel: "another-channel" } }), { session_id })).rejects.toThrow("not available");
  const task = { session_id, key: "research-open-questions", title: "Research open questions", status: "working" };
  await page.evaluate(args => meetingTest.callAgentTool("meetings_task_record", args), task);
  await page.evaluate(args => meetingTest.callAgentTool("meetings_task_record", args), { ...task, status: "done", result: "Research summary posted in the channel’s notes." });
  await expect(panel).toContainText("Done · Saved in chat");
  const messages = (await page.evaluate(() => meetingTest.workspaceState())).messages[general];
  expect(messages.at(-1)).toMatchObject({ viewer: "b".repeat(64) });
  expect(messages.at(-1).text).toContain("Research summary");
  if (test.info().project.name === "chromium") await page.screenshot({ path: "docs/screenshots/meetings-live-agent.png" });
  // This person opened Transcript first, so removing the agent leaves transcription running.
  await expect(panel).not.toContainText("also stops transcription");
  await panel.getByRole("button", { name: "Remove Research helper from call", exact: true }).click();
  await expect(stage(other).getByRole("status").filter({ hasText: "agent listening" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Remove Research helper from call", exact: true })).toHaveCount(0);
  await expect(stage(other).getByRole("status").filter({ hasText: "Shared transcription active" })).toBeVisible();
  await rail(page, "Transcript");
  const transcript = page.getByRole("complementary", { name: "Meeting transcript", exact: true });
  await expect(transcript.getByRole("status")).toHaveText("Transcribing");
  await expect(transcript.getByRole("region", { name: "Transcript entries" })).toContainText(/research|notes/i);
  await transcript.getByRole("button", { name: "Pause transcription", exact: true }).click();
  await expect(stage(other).getByRole("status").filter({ hasText: "Shared transcription active" })).toHaveCount(0);
  await rail(page, "Agent");
  // Panel remounts intentionally: choose the agent for a fresh assignment.
  await panel.getByRole("button", { name: "Add Research helper to call", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Listening · ready for spoken tasks");
  // Pausing lives in the Transcript tab; the agent's input stops with it.
  await rail(page, "Transcript");
  await transcript.getByRole("button", { name: "Pause transcription", exact: true }).click();
  await rail(page, "Agent");
  await expect(panel.getByRole("alert")).toContainText("transcription paused");
  await expect(panel.getByRole("button", { name: /^Remove Research helper/ })).toHaveCount(0);
  expect(await page.evaluate(() => meetingTest.microphoneStates())).toEqual(["live"]);
  await controls(page).getByRole("button", { name: "Leave room", exact: true }).click();
  await controls(other).getByRole("button", { name: "Leave room", exact: true }).click();
});

test("completes a task after the agent stops listening and opens its result from the saved record", async ({ page }, info) => {
  test.skip(!upstream || !process.env.BUZZ_TEST_LIVE_SPEECH, "Enable the local speech service for the real transcription workflow");
  test.setTimeout(120000);
  await page.goto(`${fixture}?realm=results-${info.project.name}&agents&speech&viewer=Alex`);
  await join(page).click();
  await expect(controls(page).getByRole("status")).toHaveText("Voice connected", { timeout: 15000 });
  await rail(page, "Agent");
  const panel = page.getByRole("region", { name: "Meeting agents", exact: true });
  await panel.getByRole("button", { name: "Add Research helper to call", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Listening · ready for spoken tasks", { timeout: 15000 });
  await expect.poll(() => page.evaluate(() => meetingTest.agentWakes().length), { timeout: 45000 }).toBeGreaterThan(0);
  const session_id = (await page.evaluate(() => meetingTest.agentWakes()))[0].text.match(/session_id ([0-9a-f-]{36})/)[1];
  const task = { session_id, key: "playtest-brief", title: "Draft the playtest brief", status: "working" };
  await page.evaluate(args => meetingTest.callAgentTool("meetings_task_record", args), task);
  await expect(panel).toContainText("Research helper · Working · Saved in chat");
  // Only the agent asked for capture, so Remove says it also stops transcription.
  const remove = panel.getByRole("button", { name: "Remove Research helper from call and stop transcription", exact: true });
  await expect(remove).toHaveText("Remove and stop transcription");
  await expect(remove).toHaveAccessibleDescription("Removing it also stops transcription here. Open Transcript first to keep it running.");
  await remove.click();
  await expect(remove).toHaveCount(0);
  await rail(page, "Transcript");
  await expect(page.getByRole("complementary", { name: "Meeting transcript", exact: true }).getByRole("status").first()).toHaveText(/^Paused for you/);
  await rail(page, "Agent");
  // The agent finishes after listening stopped; the meeting reflects it.
  await page.evaluate(args => meetingTest.callAgentTool("meetings_task_record", args), { ...task, status: "done", result: "Brief posted in the thread." });
  await expect(panel).toContainText("Research helper · Done · Saved in chat");
  const result = (await page.evaluate(() => meetingTest.workspaceState())).messages[general].at(-1);
  expect(result.text).toContain("Brief posted");
  await controls(page).getByRole("button", { name: "Leave room", exact: true }).click();
  await rail(page, "Transcript");
  const transcript = page.getByRole("complementary", { name: "Meeting transcript", exact: true });
  await transcript.getByRole("button", { name: "Save meeting record", exact: true }).click();
  await expect(transcript).toContainText("Saved in this workspace’s Meeting records.", { timeout: 15000 });
  await rail(page, "Chat");
  await linkGeneral(page);
  await library(workspace(page), "Meeting records");
  const records = workspace(page).getByRole("region", { name: "Saved meeting records" });
  await records.getByRole("button", { name: /General Voice/ }).click();
  const results = records.getByRole("list", { name: "Meeting results" });
  await expect(results.getByRole("listitem")).toHaveText(/Draft the playtest brief · Done · Research helper — Brief posted in the thread\./);
  await results.getByRole("button", { name: "Open result in thread", exact: true }).click();
  const target = (await page.evaluate(() => meetingTest.navigationTargets())).at(-1);
  expect(target).toMatchObject({ kind: "conversation", channelId: general });
  expect(target.messageId).toMatch(/^[0-9a-f]{64}$/);
});
test("an agent asks on its tile, the owner answers by clicking, others see it read-only, and its result opens in the call", async ({ page, context }, info) => {
  test.skip(!upstream || !process.env.BUZZ_TEST_LIVE_SPEECH, "Enable the local speech service for the real transcription workflow");
  test.setTimeout(120000);
  const other = await context.newPage();
  await Promise.all([page.goto(`${fixture}?realm=ask-${info.project.name}&agents&speech&viewer=Alex`), other.goto(`${fixture}?realm=ask-${info.project.name}&speech&viewer=Riley`)]);
  for (const client of [page, other]) { await join(client).click(); await expect(controls(client).getByRole("status")).toHaveText("Voice connected", { timeout: 15000 }); }
  await rail(page, "Agent");
  const panel = page.getByRole("region", { name: "Meeting agents", exact: true });
  await panel.getByRole("button", { name: "Add Research helper to call", exact: true }).click();
  await expect(panel.getByRole("status").first()).toContainText("Listening · ready for spoken tasks", { timeout: 15000 });
  await expect.poll(() => page.evaluate(() => meetingTest.agentWakes().length), { timeout: 45000 }).toBeGreaterThan(0);
  const session_id = (await page.evaluate(() => meetingTest.agentWakes()))[0].text.match(/session_id ([0-9a-f-]{36})/)[1];
  await page.evaluate(args => meetingTest.callAgentTool("meetings_ask", args), { session_id, key: "brief", question: "Turn these notes into a brief?", options: ["Yes, draft it", "Not yet"] });
  // The owner sees it on the agent's tile with buttons; the stage never changes and chat is not needed.
  const asks = stage(page).getByRole("group", { name: "Research helper asks" });
  await expect(asks).toContainText("Turn these notes into a brief?");
  await expect(asks.getByRole("button", { name: "Yes, draft it", exact: true })).toBeVisible();
  await expect(asks.getByRole("status")).toHaveText("Click or say an option.");
  await expect(asks.locator(".meeting-agent-question-timer")).toHaveAttribute("title", /Closes in \d+ s/);
  // Another participant sees it read-only and is told to say an option.
  const remote = stage(other).getByRole("group", { name: "Research helper asks" });
  await expect(remote).toContainText("Turn these notes into a brief?", { timeout: 15000 });
  await expect(remote.getByRole("button")).toHaveCount(0);
  await expect(remote.getByRole("status")).toContainText("Say an option to answer.");
  if (info.project.name === "chromium") await page.screenshot({ path: "docs/screenshots/meetings-agent-question.png" });
  await asks.getByRole("button", { name: "Yes, draft it", exact: true }).click();
  await expect(asks).toHaveCount(0);
  const answered = await page.evaluate(args => meetingTest.callAgentTool("meetings_live_context", args), { session_id });
  expect([answered.question.status, answered.question.answer.option, answered.question.answer.owner]).toEqual(["answered", "Yes, draft it", true]);
  // Status and the result live on the tile; Open result stays in the call.
  await page.evaluate(args => meetingTest.callAgentTool("meetings_task_record", args), { session_id, key: "brief", title: "Drafting the brief", status: "working" });
  await expect(stage(other).getByRole("button", { name: "Research helper · Working", exact: true })).toBeVisible({ timeout: 15000 });
  await page.evaluate(args => meetingTest.callAgentTool("meetings_task_record", args), { session_id, key: "brief", title: "Drafting the brief", status: "done", result: "Brief posted in the thread." });
  const tile = stage(page).getByRole("listitem").filter({ has: page.getByRole("button", { name: "Research helper · Finished", exact: true }) });
  await tile.getByRole("button", { name: "Open result", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute("aria-selected", "true");
  expect((await page.evaluate(() => meetingTest.navigationTargets())).filter(target => target.kind === "conversation")).toEqual([]);
  for (const client of [page, other]) await controls(client).getByRole("button", { name: "Leave room", exact: true }).click();
});
test("transcribes a room without an agent or linked channel and preserves text across navigation, pause and leave", async ({ page, context }) => {
  test.skip(!upstream || !process.env.BUZZ_TEST_LIVE_SPEECH, "Enable real speech recognition for independent transcripts");
  test.setTimeout(90000);
  const other = await context.newPage(), timelines = [[],[]], metrics = [{},{}];
  for (const [i,client] of [page,other].entries()) client.on("websocket",socket => socket.on("framereceived",frame => {
    try { const value=JSON.parse(frame.payload); if(value.type === "captions") { timelines[i].push(...value.segments.map(row => ({...row,id:`${value.streamId}:${row.seq}`}))); metrics[i]=value.metrics; } } catch { /* Other media frames. */ }
  }));
  await Promise.all([page.goto(`${fixture}?realm=independent-transcript&speech&no-agent-runtime&viewer=Alex`), other.goto(`${fixture}?realm=independent-transcript&speech&no-agent-runtime&viewer=Riley&profile-name=Alex`)]);
  const roomName = "Unlinked call";
  for (const client of [page, other]) {
    await addTemporary(client, roomName);
    await sidebar(client).getByRole("button", { name: `Join ${roomName}`, exact: true }).click();
    await expect(controls(client).getByRole("status")).toHaveText("Voice connected");
  }
  await rail(page, "Transcript");
  const panel = page.getByRole("complementary", { name: "Meeting transcript", exact: true });
  await expect(panel.getByRole("status")).toHaveText("Transcribing");
  const entries = panel.getByRole("region", { name: "Transcript entries", exact: true });
  await expect(entries).toContainText("Alex", { timeout: 45000 });
  const names=entries.locator(".meeting-transcript-speaker strong");
  await expect.poll(async()=>new Set(await names.allTextContents()).size,{timeout:45000}).toBe(2);
  for(const name of await names.allTextContents()) expect(name).toMatch(/^Alex · \S{6,}$/);
  await expect(stage(page).getByRole("button",{name:/^Show Alex · \S{6,}( \(you\))? on stage$/})).toHaveCount(2);
  await expect(entries).toContainText(/research|notes/i);
  await expect(entries).toContainText(/design|Friday/i);
  await rail(other, "Transcript");
  await expect.poll(() => metrics[0].subscribers).toBe(2);
  await expect.poll(() => metrics[1].subscribers).toBe(2);
  await expect.poll(() => timelines[1].length).toBeGreaterThan(0);
  const common=timelines[0].find(row => timelines[1].some(other => other.id===row.id));
  expect(common).toBeTruthy(); expect(timelines[1].find(row=>row.id===common.id)).toEqual(common);
  expect(metrics[0].sources).toBe(2); expect(metrics[1].sources).toBe(2);
  await writeFile(test.info().outputPath("speech-metrics.json"),JSON.stringify(metrics,null,2));
  for (const size of [{ width: 960, height: 720 }, { width: 530, height: 780 }]) {
    await page.setViewportSize(size);
    const box = await entries.boundingBox();
    expect(box.height).toBeGreaterThan(100);
    expect(box.y + box.height).toBeLessThan(size.height);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Close side panel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open side panel", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await entries.locator("time").first().getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(await page.evaluate(() => meetingTest.taskRequests())).toEqual([]);
  expect(await page.evaluate(() => meetingTest.agentWakes())).toEqual([]);
  await expect(stage(other).getByRole("status").filter({ hasText: "Shared transcription active" })).toBeVisible();
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await expect(page.getByRole("toolbar", { name: "Buzz toolbar" }).getByRole("button", { name: "Pause transcription", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Transcribing");
  await panel.getByRole("button", { name: "Pause transcription", exact: true }).click();
  // Local pause is labelled apart from the capture the second viewer keeps running.
  await expect(panel.getByRole("status")).toHaveText("Paused for you · others are transcribing this call");
  await expect(stage(other).getByRole("status").filter({ hasText: "Shared transcription active" })).toBeVisible();
  await expect.poll(() => metrics[1].subscribers).toBe(1);
  const count = await entries.getByRole("listitem").count();
  await panel.getByText("Transcript options",{exact:true}).click();
  const announcement=panel.getByRole("log",{name:"New speech",exact:true});
  await expect(announcement).toHaveAttribute("aria-live","off");
  await panel.getByRole("checkbox",{name:"Announce new speech",exact:true}).check();
  await expect(announcement).toHaveText("");
  await panel.getByRole("button", { name: "Resume transcription", exact: true }).click();
  await expect.poll(() => entries.getByRole("listitem").count(), { timeout: 45000 }).toBeGreaterThan(count);
  await expect(announcement).toContainText(/Alex · \S{6,}:/);
  await controls(page).getByRole("button", { name: "Leave room", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Call ended");
  await expect(entries).toContainText("Alex");
  expect(await page.evaluate(() => meetingTest.microphoneStates())).toEqual(["ended"]);
  await page.evaluate(() => meetingTest.switchCommunity());
  await expect(panel.getByRole("listitem")).toHaveCount(0);
  await expect(page.getByRole("log",{name:"New speech",exact:true})).toHaveCount(0);
  await controls(other).getByRole("button", { name: "Leave room", exact: true }).click();
});

test("shares sound independently of the microphone and stops it with viewing, source changes and capture cancellation", async ({ page, context }) => {
  test.skip(!upstream, "Run npm run test:media against the updated broker");
  test.setTimeout(60000);
  const other = await context.newPage();
  await Promise.all([page.goto(`${fixture}?viewer=Alex&realm=screen-sound`), other.goto(`${fixture}?viewer=Riley&realm=screen-sound`)]);
  for (const client of [page, other]) { await join(client).click(); await expect(controls(client).getByRole("status")).toHaveText("Voice connected"); }
  await controls(page).getByRole("button", { name: "Share screen", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Screen sharing", exact: true });
  await drawer.getByRole("checkbox", { name: "Share sound when available" }).check();
  await drawer.getByRole("button", { name: "Choose screen or window", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await controls(page).getByRole("button", { name: "Sharing options", exact: true }).click();
  await expect(drawer).toContainText("Sharing screen sound");
  await other.getByRole("button", { name: "Watch Alex’s stream", exact: true }).click();
  const sound = other.locator('audio[data-meeting-source="screen_share_audio"]');
  await expect(sound).toHaveCount(1); await expect.poll(() => sound.evaluate(element => element.currentTime)).toBeGreaterThan(0);
  const rms = () => sound.evaluate(async element => {
    const context = new AudioContext(); await context.resume();
    const source = context.createMediaStreamSource(element.srcObject), analyser = context.createAnalyser(); source.connect(analyser);
    await new Promise(resolve => setTimeout(resolve, 150)); const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
    source.disconnect(); await context.close(); return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  });
  await expect.poll(rms).toBeGreaterThan(0.01);
  await controls(page).getByRole("button", { name: "Mute", exact: true }).click();
  await expect.poll(rms).toBeGreaterThan(0.01);
  await controls(other).getByRole("button", { name: "Deafen", exact: true }).click(); await expect(sound).toHaveJSProperty("muted", true);
  await controls(other).getByRole("button", { name: "Undeafen", exact: true }).click(); await expect(sound).toHaveJSProperty("muted", false);
  await other.getByRole("button", { name: "Stop watching", exact: true }).click(); await expect(sound).toHaveCount(0);
  await other.getByRole("button", { name: "Watch Alex’s stream", exact: true }).click(); await expect(sound).toHaveCount(1);
  if (!await drawer.isVisible()) await controls(page).getByRole("button", { name: "Sharing options", exact: true }).click();
  await drawer.getByRole("button", { name: "Change source", exact: true }).click();
  await expect.poll(() => page.evaluate(() => meetingTest.screenAudioStates())).toEqual(["ended", "live"]);
  await expect(sound).toHaveCount(1); await expect.poll(rms).toBeGreaterThan(0.01);
  await page.evaluate(() => meetingTest.omitNextScreenSound());
  await expect(drawer).not.toBeVisible();
  await controls(page).getByRole("button", { name: "Sharing options", exact: true }).click();
  await drawer.getByRole("button", { name: "Change source", exact: true }).click();
  await expect(drawer).toContainText("picker returned no audio"); await expect(sound).toHaveCount(0);
  await drawer.getByRole("button", { name: "Close sharing options", exact: true }).click();
  await controls(page).getByRole("button", { name: "Stop sharing", exact: true }).click();
  await page.evaluate(() => meetingTest.holdScreen());
  await startShare(page);
  await drawer.getByRole("button", { name: "Cancel screen share", exact: true }).click();
  await page.evaluate(() => meetingTest.releaseScreen());
  await expect.poll(() => page.evaluate(() => meetingTest.screenAudioStates())).toEqual(["ended", "ended", "ended"]);
  for (const client of [page, other]) await controls(client).getByRole("button", { name: "Leave room", exact: true }).click();
});


test("remembers join-muted audio settings and preserves an unsent agent request",async ({page}) => {
  test.skip(!upstream,"Needs real call transport");
  await page.goto(`${fixture}?realm=simple-audio&agents`);
  await page.getByRole("button",{name:"Audio settings",exact:true}).click();
  const audio=page.getByRole("dialog",{name:"Audio settings",exact:true});
  await audio.getByLabel("Join with microphone muted").check();
  await page.keyboard.press("Escape"); await page.reload();
  await join(page).click(); await expect(controls(page).getByRole("button",{name:"Unmute",exact:true})).toBeVisible();
  await sidebar(page).getByRole("button",{name:"Add agent",exact:true}).click();
  const agents=page.getByRole("region",{name:"Meeting agents",exact:true});
  await agents.getByText("Send a written task",{exact:true}).click();
  await agents.getByLabel("Agent",{exact:true}).selectOption("b".repeat(64));
  await agents.getByLabel("Request",{exact:true}).fill("Keep this draft while I check the transcript.");
  await rail(page, "Transcript");
  await rail(page,"Agent");
  await agents.getByText("Send a written task",{exact:true}).click();
  await expect(agents.getByLabel("Request",{exact:true})).toHaveValue("Keep this draft while I check the transcript.");
  await controls(page).getByRole("button",{name:"Leave room",exact:true}).click();
});

test("adds two agents directly as call members with one transcription connection",async ({page}) => {
  test.skip(!upstream || !process.env.BUZZ_TEST_LIVE_SPEECH,"Needs real speech transport"); test.setTimeout(90000);
  let connections=0; page.on("websocket",socket=>socket.on("framesent",frame=>{try{if(["captions","listen"].includes(JSON.parse(frame.payload).type)) connections++;}catch{}}));
  await page.goto(`${fixture}?realm=multi-agents&agents&multi-agents&speech`); await join(page).click();
  await sidebar(page).getByRole("button",{name:"Add agent",exact:true}).click();
  const agents=page.getByRole("region",{name:"Meeting agents",exact:true});
  await agents.getByRole("button",{name:"Add Research helper to call",exact:true}).click();
  // Alone, the agent is the only reason for capture; with a second agent, neither is.
  await expect(agents.getByRole("button",{name:"Remove Research helper from call and stop transcription",exact:true})).toBeVisible();
  await agents.getByRole("button",{name:"Add New helper to call",exact:true}).click();
  await expect(agents.getByRole("button",{name:"Remove New helper from call",exact:true})).toBeVisible();
  await expect(agents.getByRole("button",{name:"Remove Research helper from call",exact:true})).toBeVisible();
  expect(connections).toBe(1);
  await expect(sidebar(page).getByRole("button",{name:"Research helper · Listening",exact:true})).toBeVisible();
  await expect(sidebar(page).getByRole("button",{name:"New helper · Listening",exact:true})).toBeVisible();
  expect((await page.evaluate(()=>meetingTest.taskRequests())).filter(task=>task.text.includes("Live meeting session:")).length).toBe(2);
  await agents.getByRole("button",{name:"Remove Research helper from call",exact:true}).click();
  await expect(sidebar(page).getByRole("button",{name:"New helper · Listening",exact:true})).toBeVisible();
  await expect(agents.getByRole("button",{name:"Remove New helper from call and stop transcription",exact:true})).toBeVisible();
  await rail(page, "Transcript");
  const transcript=page.getByRole("complementary",{name:"Meeting transcript",exact:true});
  await expect(transcript.getByRole("region",{name:"Transcript entries"})).toContainText(/research|notes/i,{timeout:45000});
  await transcript.getByRole("button",{name:"Save meeting record",exact:true}).click();
  await expect(transcript).toContainText("Saved in this workspace’s Meeting records.");
  const saved=(await page.evaluate(()=>meetingTest.workspaceState())).records.filter(event=>event.tags.some(tag=>tag[0]==="type" && tag[1]==="studio.h2s2.meetings.record"));
  expect(saved).toHaveLength(1);
  await controls(page).getByRole("button",{name:"Leave room",exact:true}).click();
});


test("creates a private meeting directly from its sidebar and returns keyboard focus on cancel",async({page})=>{
  await page.goto(`${fixture}?realm=direct-create`);
  const trigger=workspaces(page).getByRole("button",{name:"Create meeting",exact:true});
  await trigger.click();
  const dialog=page.getByRole("dialog",{name:"Create meeting",exact:true});
  await expect(dialog.getByLabel("Meeting name",{exact:true})).toBeFocused();
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await trigger.click(); await dialog.getByLabel("Meeting name",{exact:true}).fill("Product review");
  await dialog.getByRole("button",{name:"Create meeting",exact:true}).click();
  await expect(workspace(page).getByRole("heading",{name:"Product review",exact:true})).toBeVisible();
  const value=await page.evaluate(()=>meetingTest.workspaceState());
  expect(value.channels.find(channel=>channel.name==="Product review").visibility).toBe("private");
  expect(await page.evaluate(()=>meetingTest.microphoneStates())).toEqual([]);
});

test("activates before a community is selected and binds workspaces and records once one is", async ({ page }) => {
  const failures = []; page.on("pageerror", error => failures.push(error.message));
  await page.goto(`${fixture}?cold&realm=cold-start`);
  await expect(sidebar(page).getByRole("heading", { name: "Meetings" })).toBeVisible();
  await page.evaluate(() => meetingTest.selectCommunity());
  await linkGeneral(page);
  await library(workspace(page), "Meeting records");
  const records = workspace(page).getByRole("region", { name: "Saved meeting records" });
  await expect(records).toContainText("Save a transcript during or after a call");
  await expect(records.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => meetingTest.switchCommunity());
  await page.evaluate(() => meetingTest.selectCommunity());
  await expect(workspaces(page).getByRole("button", { name: "General Voice", exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});
test("never asks an older meeting service for presence and says who’s here appears after joining", async ({ page }) => {
  const serviceIdentity = "e".repeat(64), requests = [];
  // A service reply without the presence capability, as from a broker before it existed.
  await page.routeWebSocket(/\/rooms$/, socket => socket.onMessage(raw => {
    const request = JSON.parse(raw); requests.push(request);
    if (request.type === "service") socket.send(JSON.stringify({ type: "service", workspaceVoice: true, identity: serviceIdentity, community: new URL(fixture).origin }));
  }));
  await page.goto(`${fixture}?realm=old-service`);
  await linkGeneral(page);
  const view = workspace(page);
  await view.getByRole("button", { name: "Enable voice & join", exact: true }).waitFor();
  await page.evaluate(() => meetingTest.workspaceControl({ grant: { id: "10000000-0000-4000-8000-000000000001", viewer: "e".repeat(64), role: "guest" } }));
  await expect(view.getByRole("status").filter({ hasText: "Who’s here appears after you join." })).toBeVisible();
  await expect(view.getByRole("heading", { name: "Who’s in the call" })).toBeVisible();
  await page.waitForTimeout(1500);
  expect(requests.filter(request => request.presence || request.type === "presence")).toEqual([]);
  expect(requests.filter(request => request.type === "workspace")).toEqual([]);
  await expect(view.getByRole("alert")).toHaveCount(0);
});
test("edits a shared document, holds a clash for Keep mine / Keep theirs / Compare and explains a kept removal", async ({ page }) => {
  await page.goto(`${fixture}?realm=documents`);
  await linkGeneral(page);
  const view = workspace(page);
  await library(view, /^Documents & boards/);
  const list = view.getByRole("region", { name: "Documents and boards" });
  await expect(list.getByRole("note")).toContainText("Preview: documents aren’t saved to Buzz yet.");
  await list.getByRole("button", { name: "New document", exact: true }).click();
  const editor = view.getByRole("region", { name: /^Document: / });
  const footer = editor.getByRole("status").filter({ hasText: /Saved|Saving|Unsaved/ });
  await editor.getByLabel("Document title", { exact: true }).fill("Turn 3 playtest brief"); await editor.getByLabel("Document title", { exact: true }).blur();
  await editor.getByLabel("Paragraph 1", { exact: true }).fill("Seven of nine players missed the apex.");
  await expect(footer).toContainText("Saved · revision 3");
  await editor.getByRole("button", { name: "Add paragraph", exact: true }).click();
  await editor.getByLabel("Paragraph 2", { exact: true }).fill("The braking marker sits behind the bridge shadow.");
  await expect(footer).toContainText("Saved · revision 5");
  // Someone else changes paragraph 2 while Sam is typing in it.
  await editor.getByLabel("Paragraph 2", { exact: true }).fill("We should test again on Thursday.");
  await page.evaluate(() => meetingTest.remoteDocumentEdit({ by: "b".repeat(64), index: 1, text: "Retest planned for Friday." }));
  const clash = editor.getByRole("group", { name: "Your version" });
  await expect(clash).toContainText("Research helper changed this paragraph while you were typing.");
  await expect(editor.getByLabel("Paragraph 2", { exact: true })).toHaveValue("Retest planned for Friday.");
  await clash.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(clash).toContainText("Yours"); await expect(clash).toContainText("We should test again on Thursday.");
  await clash.getByRole("button", { name: "Keep mine", exact: true }).click();
  await expect(clash).toHaveCount(0);
  await expect(editor.getByLabel("Paragraph 2", { exact: true })).toHaveValue("We should test again on Thursday.");
  // The clashing save had nothing else to publish; Keep mine is revision 7.
  await expect(footer).toContainText("Saved · revision 7");
  // Sam removes paragraph 1 while it is being edited elsewhere: it is kept, and the editor says why.
  await editor.getByLabel("Paragraph 2", { exact: true }).fill("Thursday, after the patch.");
  await page.evaluate(() => meetingTest.remoteDocumentEdit({ by: "b".repeat(64), index: 0, text: "Seven of nine players braked late." }));
  await editor.getByRole("button", { name: "Remove paragraph 1", exact: true }).click();
  await expect(editor.getByRole("status").filter({ hasText: "Kept — Research helper edited this while you were removing it." })).toBeVisible();
  await expect(editor.getByLabel("Paragraph 1", { exact: true })).toHaveValue("Seven of nine players braked late.");
  await expect.poll(() => page.evaluate(() => meetingTest.documents()[0].texts)).toEqual(["Seven of nine players braked late.", "Thursday, after the patch."]);
  // Typing right before closing is flushed, not dropped.
  await editor.getByRole("button", { name: "Add heading", exact: true }).click();
  await editor.getByLabel("Heading 3", { exact: true }).fill("Next session");
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => page.evaluate(() => meetingTest.documents()[0].texts.at(-1))).toBe("Next session");
  await expect(list.getByRole("button", { name: /Turn 3 playtest brief/ })).toContainText("Document · revision");
  await expect(view.getByRole("group", { name: "Library" }).getByRole("button", { name: /^Documents & boards/ })).toContainText("Preview");
});
test("builds a board by pointer and keyboard, then turns selected cards into a linked brief", async ({ page }) => {
  await page.goto(`${fixture}?realm=board`);
  await linkGeneral(page);
  const view = workspace(page);
  await view.getByRole("group", { name: "Workspace views" }).getByRole("button", { name: /^Documents & boards/ }).click();
  await view.getByRole("button", { name: "New board", exact: true }).click();
  const board = view.getByRole("region", { name: /^Board: / });
  const toolbar = board.getByRole("toolbar", { name: "Board" });
  for (const text of ["Move the braking marker", "Brighter kerb paint", "Show the radius on the minimap"]) {
    await toolbar.getByRole("button", { name: "Add card", exact: true }).click();
    const input = board.getByLabel("Card text", { exact: true });
    await input.fill(text); await input.press("Enter");
    await expect(board.getByRole("button", { name: `Card: ${text}`, exact: true })).toBeVisible();
  }
  const card = text => board.getByRole("button", { name: `Card: ${text}`, exact: true });
  // Select two by clicking, group and connect them.
  await card("Move the braking marker").click();
  await card("Brighter kerb paint").click({ modifiers: ["Shift"] });
  await toolbar.getByRole("button", { name: "Group", exact: true }).click();
  const name = board.getByLabel("Group name", { exact: true }); await name.fill("Visibility"); await name.press("Enter");
  await card("Move the braking marker").click();
  await card("Show the radius on the minimap").click({ modifiers: ["Shift"] });
  await toolbar.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(board.locator(".meeting-board-links line")).toHaveCount(1);
  // Drag a card; one move is saved where it was dropped.
  const before = await card("Show the radius on the minimap").boundingBox();
  await page.mouse.move(before.x + 20, before.y + 20); await page.mouse.down(); await page.mouse.move(before.x + 140, before.y + 90, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => Math.round((await card("Show the radius on the minimap").boundingBox()).x - before.x)).toBe(120);
  // Keyboard: arrows nudge the focused card.
  await card("Brighter kerb paint").focus(); const nudge = await card("Brighter kerb paint").boundingBox();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => Math.round((await card("Brighter kerb paint").boundingBox()).x - nudge.x)).toBe(12);
  if (test.info().project.name === "chromium") await page.screenshot({ path: "docs/screenshots/meetings-board.png" });
  // Outline: the same board as a keyboard list.
  await board.getByRole("button", { name: "Outline", exact: true }).click();
  const outline = board.getByRole("listbox", { name: "Board outline" });
  await expect(outline.getByRole("option")).toHaveText([/^Visibility/, /^Move the braking marker/, /^Brighter kerb paint/, /^Show the radius on the minimap/]);
  await outline.focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  const edit = board.getByLabel("Card text", { exact: true }); await edit.fill("Move the marker out of the shadow"); await edit.press("Enter");
  await expect(outline.getByRole("option").nth(1)).toHaveText(/^Move the marker out of the shadow/);
  await page.keyboard.press("Space"); await page.keyboard.press("End"); await page.keyboard.press("Space");
  await expect(board.getByRole("status").filter({ hasText: "2 cards selected" })).toBeVisible();
  await board.getByRole("button", { name: "Turn into a brief", exact: true }).click();
  const brief = view.getByRole("region", { name: /^Document: Brief: / });
  await expect(brief).toContainText("Made from 2 cards on a board");
  await expect(brief.getByLabel("Heading 2", { exact: true })).toHaveValue("Visibility");
  await expect(brief.getByLabel("Paragraph 3", { exact: true })).toHaveValue("Move the marker out of the shadow");
  await expect(brief.getByLabel("Paragraph 4", { exact: true })).toHaveValue("Show the radius on the minimap");
  await brief.getByRole("button", { name: "Open board", exact: true }).click();
  await expect(view.getByRole("region", { name: /^Board: / })).toBeVisible();
});
test("keeps a failed workspace microphone join visible and available to retry",async({page})=>{
  const serviceIdentity="e".repeat(64);
  await page.routeWebSocket(/\/rooms$/,socket=>socket.onMessage(raw=>{
    const request=JSON.parse(raw);
    if(request.type==="service") socket.send(JSON.stringify({type:"service",workspaceVoice:true,identity:serviceIdentity,community:new URL(fixture).origin}));
  }));
  await page.goto(`${fixture}?realm=workspace-denied&deny`);
  await linkGeneral(page);
  const view=workspace(page);
  await view.getByRole("button",{name:"Enable voice & join",exact:true}).click();
  await expect(view.getByRole("alert")).toContainText("Microphone permission was denied");
  await expect(view.getByRole("button",{name:"Join voice",exact:true})).toBeEnabled();
  await expect(view.locator(":scope > header").getByRole("heading",{name:"General Voice",exact:true})).toBeVisible();
  await expect(page.getByLabel("Shared notes")).toBeVisible();
  expect(await page.evaluate(()=>meetingTest.microphoneStates())).toEqual([]);
});
