import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import { workspaceFixturePlugin } from "./workspace-http.mjs";
import { identities, general, design } from "./workspace-host.mjs";
test.use({ permissions: ["microphone", "camera"] });
let site, fixture;
const upstream = process.env.BUZZ_TEST_UPSTREAM_URL;
test.beforeAll(async () => {
  site = await createServer({ configFile: false, plugins: [workspaceFixturePlugin()], server: { host: "127.0.0.1", port: 0, watch: null,
    ...(upstream && { proxy: { "/rooms": { target: upstream, ws: true, headers: {
      "X-Buzz-Streams-Proxy-Key": process.env.BUZZ_TEST_PROXY_KEY, Origin: "tauri://localhost" } } } }) } });
  await site.listen(); fixture = `http://127.0.0.1:${site.httpServer.address().port}/test/fixture.html`;
});
test.afterAll(async () => { await site.close(); });
const sidebar = page => page.getByRole("navigation", { name: "Meeting rooms" });
const stage = page => page.getByRole("region", { name: "Meeting", exact: true });
const controls = page => stage(page).getByRole("group", { name: "Meeting controls" });
const join = page => sidebar(page).getByRole("button", { name: "Join General Voice", exact: true });
const video = page => page.getByLabel("Shared screen", { exact: true });
async function playback(locator) {
  await expect(locator).toBeVisible({ timeout: 15000 });
  await expect.poll(() => locator.evaluate(element => element.currentTime)).toBeGreaterThan(0);
}
test("automatically presents rooms, persists names, and reports denied microphone permission", async ({ page }) => {
  await page.goto(`${fixture}?deny`);
  await expect(sidebar(page).getByRole("heading", { name: "Voice Channels" })).toBeVisible();
  await page.getByRole("button", { name: "Add voice channel" }).click();
  await page.getByLabel("Room name", { exact: true }).fill("Design Room");
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  await page.reload();
  await expect(sidebar(page).getByRole("button", { name: "Join Design Room" })).toBeVisible();
  await join(page).click();
  await expect(page.getByRole("alert")).toContainText("Microphone permission was denied");
  await expect(sidebar(page).getByRole("list", { name: "Connected participants" })).toHaveCount(0);
  expect(await page.evaluate(() => meetingTest.microphoneStates())).toEqual([]);
});
test("top-aligns rooms below host navigation and persists create, rename, and removal", async ({ page }) => {
  await page.setViewportSize({ width: 530, height: 2064 });
  await page.goto(`${fixture}?deny`);
  const activity = await page.getByRole("button", { name: "Activity", exact: true }).boundingBox();
  const heading = await sidebar(page).getByRole("heading", { name: "Voice Channels" }).boundingBox();
  expect(heading.y).toBeLessThan(activity.y + activity.height + 64);
  expect(heading.y).toBeLessThan(200);
  const lastVoiceRow = await sidebar(page).getByRole("button", { name: /^Join / }).last().boundingBox();
  const workspaceHeading = await workspaces(page).getByRole("heading", { name: "Workspaces", exact: true }).boundingBox();
  const workspaceGap = workspaceHeading.y - (lastVoiceRow.y + lastVoiceRow.height);
  expect(workspaceGap).toBeGreaterThanOrEqual(0);
  expect(workspaceGap).toBeLessThan(64);
  await page.getByRole("button", { name: "Manage voice channels", exact: true }).click();
  await page.getByLabel("Channel name", { exact: true }).fill("Design Room");
  await page.getByRole("button", { name: "Create voice channel", exact: true }).click();
  await page.getByRole("button", { name: "Rename General Voice", exact: true }).click();
  await page.getByLabel("New channel name", { exact: true }).fill("Lounge");
  await page.getByRole("button", { name: "Save channel name", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rename Lounge", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rename Lounge", exact: true }).click();
  await page.getByLabel("New channel name", { exact: true }).fill("Design Room");
  await page.getByRole("button", { name: "Save channel name", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("already in your list");
  await page.getByRole("button", { name: "Cancel rename", exact: true }).click();
  if (test.info().project.name === "chromium") { await page.setViewportSize({ width: 1280, height: 787 }); await page.screenshot({ path: "docs/screenshots/meetings-manage.png" }); }
  await page.getByRole("button", { name: "Remove Lounge", exact: true }).click();
  await page.getByRole("button", { name: "Remove channel shortcut", exact: true }).click();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await expect(sidebar(page).getByRole("button", { name: "Join Lounge", exact: true })).toHaveCount(0);
  await expect(sidebar(page).getByRole("button", { name: "Join Design Room", exact: true })).toBeVisible();
  await page.reload();
  await expect(join(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Manage voice channels", exact: true }).click();
  await page.getByRole("button", { name: "Remove Design Room", exact: true }).click();
  await page.getByRole("button", { name: "Remove channel shortcut", exact: true }).click();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await expect(page.getByText("Create a voice channel to start a conversation.")).toBeVisible();
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
  await page.getByRole("button", { name: "Add voice channel" }).click();
  await page.getByLabel("Room name", { exact: true }).fill("Design");
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  await sidebar(page).getByRole("button", { name: "Join Design", exact: true }).click();
  await expect(conversation).toHaveAttribute("data-channel", design);
  await expect(conversation).not.toContainText("Notes for General Voice");
  await page.getByRole("button", { name: "Hide room chat" }).click();
  await expect(conversation).toHaveCount(0);
});
test("cancels a pending microphone prompt without leaking a late capture", async ({ page }) => {
  await page.goto(`${fixture}?hold`); await join(page).click();
  await controls(page).getByRole("button", { name: "Leave room" }).click();
  await page.evaluate(() => meetingTest.releaseMicrophone());
  await expect.poll(() => page.evaluate(() => meetingTest.microphoneStates())).toEqual(["ended"]);
  await expect(page.getByRole("status")).toHaveCount(0);
});

const workspaces = page => page.getByRole("navigation", { name: "Shared workspaces" });
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
    for (const client of [page, second]) await client.getByRole("button", { name: "Chat & files", exact: true }).click();
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
      await client.getByRole("button", { name: "Chat & files", exact: true }).click();
      await expect(client.getByRole("region", { name: "Native conversation" })).toContainText("https://example.com/design.pdf");
      expect(await client.evaluate(() => meetingTest.microphoneRequests())).toBe(0);
    }
    const evidence = await page.evaluate(() => meetingTest.workspaceControl({}));
    expect(evidence.events).toHaveLength(1); expect(evidence.publications).toHaveLength(1);
    expect(evidence.events[0].tags).toContainEqual(["h", general]);
    if (info.project.name === "chromium") { await page.getByRole("button", { name: "Notes", exact: true }).click(); await page.screenshot({ path: "docs/screenshots/meetings-workspace.png", fullPage: true }); }
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
    await second.getByRole("button", { name: "Chat & files", exact: true }).click();
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
  await controls(first).getByRole("button", { name: "Camera off", exact: true }).click();
  await expect(second.getByLabel("Alex’s camera", { exact: true })).toHaveCount(0);
  await first.evaluate(() => meetingTest.cancelNextCapture());
  await first.getByRole("button", { name: "Share screen", exact: true }).click();
  await expect(first.getByRole("alert")).toContainText("Screen selection canceled");
  for (const client of [first, second]) await client.getByRole("button", { name: "Share screen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Watch Alex’s stream" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Watch Riley’s stream" })).toBeVisible();
  await page.getByRole("button", { name: "Watch Alex’s stream" }).click(); await playback(video(page));
  await first.getByRole("button", { name: "Change source" }).click();
  await expect(first.getByText("Window 2 · Your screen")).toBeVisible();
  await page.getByRole("button", { name: "Watch all screens" }).click();
  await playback(page.getByLabel("Alex’s screen", { exact: true })); await playback(page.getByLabel("Riley’s screen", { exact: true }));
  if (test.info().project.name === "chromium") await page.screenshot({ path: "docs/screenshots/meetings.png", fullPage: true });
  await first.getByRole("button", { name: "Messages", exact: true }).click();
  await expect(first.getByRole("toolbar", { name: "Buzz toolbar" }).getByRole("button", { name: "Leave room" })).toBeVisible();
  expect(await first.evaluate(() => meetingTest.microphoneStates())).toEqual(["live"]);
  expect(await first.evaluate(() => meetingTest.captureStates())).toEqual(["ended", "live"]);
  await first.getByRole("toolbar", { name: "Buzz toolbar" }).getByRole("button", { name: "Leave room" }).click();
  await expect(roster.getByRole("listitem")).toHaveCount(2);
  expect(await first.evaluate(() => meetingTest.microphoneStates())).toEqual(["ended"]);
  expect(await first.evaluate(() => meetingTest.captureStates())).toEqual(["ended", "ended"]);
  await page.getByRole("button", { name: "Add voice channel" }).click();
  await page.getByLabel("Room name", { exact: true }).fill("Design");
  await page.getByRole("button", { name: "Add room", exact: true }).click();
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
