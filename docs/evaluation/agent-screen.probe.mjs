// Local feasibility check. Content and authors are scripted. The receiver is the PR bundle.
import { expect, test } from "@playwright/test";
import { createServer } from "vite";
import { readFile } from "node:fs/promises";
import { workspaceFixturePlugin } from "../../test/workspace-http.mjs";

const media = process.env.BUZZ_TEST_UPSTREAM_URL;
const button = (page, name) => page.getByRole("button", { name, exact: true });
test.use({ permissions: ["microphone", "camera"], viewport: { width: 1440, height: 860 } });

// This test document and board live in process memory. Human edits and the
// presenter use the same object IDs. The video frame is only a view of them.
function presentationFixture() {
  const documents = new Map();
  let presenting;
  function create(id, surface) { documents.set(id, surface); presenting = id; }
  const plugin = {
    name: "meeting-presentation-fixture",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url === "/review-presenter") {
          res.setHeader("Content-Type", "text/html");
          return res.end('<canvas width="960" height="540"></canvas><script src="/review-sdk"></script>');
        }
        if (req.url === "/review-sdk") {
          res.setHeader("Content-Type", "application/javascript");
          return res.end(await readFile(new URL("../../node_modules/livekit-client/dist/livekit-client.umd.js", import.meta.url)));
        }
        if (req.url === "/review-edit") {
          res.setHeader("Content-Type", "text/html");
          return res.end('<form><label>Next experiment <input name="idea"></label><button>Save card</button></form><output></output><script>document.querySelector("form").onsubmit=async e=>{e.preventDefault();const r=await fetch("/review-board-card",{method:"POST",body:new FormData(e.target).get("idea")});document.querySelector("output").textContent=r.ok?"Saved":"Could not save";}</script>');
        }
        if (req.url === "/review-board-card" && req.method === "POST") {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const text = Buffer.concat(chunks).toString().trim();
          documents.get("ideas").cards.push({ title: text, author: "Riley" });
          return res.end("ok");
        }
        if (req.url !== "/review-presenting") return next();
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(documents.get(presenting)));
      });
    },
  };
  return { plugin, create, documents };
}

async function present() {
  const { Room, Track } = window.LivekitClient;
  const { requestRoom } = await import("/src/admission.ts");
  const admitted = await requestRoom(location.origin.replace("http", "ws") + "/rooms", {
    type: "meeting", community: location.origin, room: "General Voice", name: "Studio agent",
  }, AbortSignal.timeout(10000));
  const room = new Room();
  await room.connect(admitted.url, admitted.token, { autoSubscribe: false });
  const canvas = document.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  ctx.scale(canvas.width / 1440, canvas.height / 810);
  const words = (text, x, y, size, color, bold = false) => {
    ctx.font = (bold ? "600 " : "") + size + "px Arial, sans-serif";
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };
  function draw(surface) {
    const board = surface.kind === "board";
    ctx.fillStyle = board ? "#e7efea" : "#f8f4ec";
    ctx.fillRect(0, 0, 1440, 810);
    if (board) {
      ctx.fillStyle = "#c3d4ca";
      for (let y = 144; y < 810; y += 28) for (let x = 24; x < 1440; x += 28) ctx.fillRect(x, y, 2, 2);
    }
    words(board ? "Ideation board" : "Meeting document", 72, 75, 28, "#3e6457");
    words(surface.title, 72, 166, 66, "#172c26", true);
    if (board) {
      const palette = ["#f6e0a3", "#cadfd2", "#c5d7ec", "#edd3c3"];
      surface.cards.forEach((card, i) => {
        const x = 72 + (i % 2) * 660, y = 218 + Math.floor(i / 2) * 218;
        ctx.fillStyle = palette[i];
        ctx.beginPath(); ctx.roundRect(x, y, 620, 180, 16); ctx.fill();
        words(card.title, x + 32, y + 76, 36, "#192e29", true);
        words(card.author, x + 32, y + 136, 27, "#3c504a");
      });
    } else {
      for (const [i, section] of surface.sections.entries()) {
        const y = 274 + i * 164;
        words(section.heading, 76, y, 34, "#254f40", true);
        words(section.text, 76, y + 64, 37, "#24342e");
      }
    }
  }
  let closed = false, timer, track;
  async function refresh() {
    const surface = await (await fetch("/review-presenting")).json();
    if (closed) return;
    draw(surface);
    // A presenter's caret changes frames even while the text stays still.
    if (Math.floor(performance.now() / 500) % 2 === 0) {
      ctx.fillStyle = "#315c49";
      ctx.fillRect(75, 716, 4, 34);
    }
    track?.requestFrame?.();
    timer = setTimeout(refresh, 150);
  }
  await refresh();
  const stream = canvas.captureStream(8);
  [track] = stream.getVideoTracks();
  await room.localParticipant.publishTrack(track, {
    name: "workspace-presentation", source: Track.Source.ScreenShare, simulcast: false,
  });
  window.stopPresentation = async () => {
    closed = true; clearTimeout(timer);
    await room.localParticipant.unpublishTrack(track);
    track.stop(); await room.disconnect();
  };
}

// Check decoded remote pixels. A visible video element alone cannot establish
// that changing the document, board or card reached the other participant.
async function expectPixel(video, x, y, rgb) {
  await expect.poll(() => video.evaluate((element, { x, y, rgb }) => {
    if (!element.videoWidth || element.readyState < 2) return { ready: element.readyState, size: element.videoWidth };
    const sample = document.createElement("canvas");
    const ctx = sample.getContext("2d");
    ctx.drawImage(element, x * element.videoWidth, y * element.videoHeight, 1, 1, 0, 0, 1, 1);
    const actual = ctx.getImageData(0, 0, 1, 1).data;
    // Published RGB crosses a video color-space conversion. Both target cards
    // have a warm hue, distinctly different from the nearly neutral board.
    const warmCard = actual[0] - actual[2] > 25;
    return (warmCard && rgb.every((value, i) => Math.abs(actual[i] - value) < 32)) || {
      rgb: Array.from(actual).slice(0, 3), size: element.videoWidth, time: element.currentTime,
    };
  }, { x, y, rgb }), { timeout: 15000 }).toBe(true);
}

async function headingHasInk(video, top) {
  return video.evaluate((element, top) => {
    if (!element.videoWidth) return false;
    const sample = document.createElement("canvas");
    sample.width = 200; sample.height = 24;
    const ctx = sample.getContext("2d");
    ctx.drawImage(element, 0.05 * element.videoWidth, top * element.videoHeight,
      0.24 * element.videoWidth, 0.06 * element.videoHeight, 0, 0, 200, 24);
    const pixels = ctx.getImageData(0, 0, 200, 24).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] < 150) dark++;
    return dark > 40;
  }, top);
}

test("a rendered document and board share the agent screen alongside a human share", async ({ browser }, info) => {
  test.skip(!media, "Run through the repository's local test:media launcher");
  test.setTimeout(65000);
  const content = presentationFixture();
  content.create("brief", { kind: "document", title: "First playtest brief", sections: [
    { heading: "Question", text: "Can a new player find the first objective unaided?" },
    { heading: "Evidence to collect", text: "Log the first wrong turn and the first request for help." },
  ] });
  const site = await createServer({ configFile: false, plugins: [workspaceFixturePlugin(), content.plugin],
    server: { host: "127.0.0.1", port: 0, watch: null, proxy: {
      "/rooms": { target: media, ws: true, changeOrigin: true, headers: {
        "X-Buzz-Streams-Proxy-Key": process.env.BUZZ_TEST_PROXY_KEY, Origin: "tauri://localhost",
      } },
    } },
  });
  const contexts = [];
  try {
    await site.listen();
    const root = "http://127.0.0.1:" + site.httpServer.address().port;
    async function open(path) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 860 }, permissions: ["microphone", "camera"] });
      contexts.push(context);
      const page = await context.newPage(); await page.goto(root + path);
      return page;
    }
    const sam = await open("/test/fixture.html?viewer=Sam");
    const riley = await open("/test/fixture.html?viewer=Riley");
    for (const page of [sam, riley]) {
      await button(page.getByRole("navigation", { name: "Meetings", exact: true }), "Join General Voice").click();
      await expect(page.getByRole("group", { name: "Meeting controls" }).getByRole("status")).toHaveText("Voice connected");
      await button(page, "Close side panel").click();
    }
    await button(riley, "Share screen").click(); await button(riley, "Choose screen or window").click();
    const agent = await open("/review-presenter");
    await agent.evaluate(present);
    const screen = sam.getByLabel("Shared screen", { exact: true });
    await button(sam, "Watch Studio agent’s stream").click();
    await expect.poll(() => headingHasInk(screen, 0.29), { timeout: 15000 }).toBe(true);
    expect(await headingHasInk(screen, 0.695)).toBe(false);
    content.documents.get("brief").sections.push({
      heading: "Next session", text: "Riley will run three playtests on Thursday.",
    });
    await expect.poll(() => headingHasInk(screen, 0.695), { timeout: 15000 }).toBe(true);
    await sam.screenshot({ path: info.outputPath("agent-document.png") });
    content.create("ideas", { kind: "board", title: "How could we guide the player?", cards: [
      { title: "Landmark at the first turn", author: "Studio agent" },
      { title: "Light the return path", author: "Studio agent" },
      { title: "Test with the sound off", author: "Studio agent" },
    ] });
    await expectPixel(screen, 0.3, 0.31, [246, 224, 163]);
    const editor = await riley.context().newPage();
    await editor.goto(root + "/review-edit");
    await editor.getByLabel("Next experiment").fill("Try one silent playtest");
    await button(editor, "Save card").click(); await expect(editor.locator("output")).toHaveText("Saved");
    await expectPixel(screen, 0.8, 0.58, [237, 211, 195]);
    expect(content.documents.get("ideas").cards.at(-1)).toMatchObject({ title: "Try one silent playtest", author: "Riley" });
    expect(content.documents.get("brief").sections).toHaveLength(3);
    await sam.screenshot({ path: info.outputPath("agent-whiteboard.png") });
    await expect(button(sam, "Watch Riley’s stream")).toBeVisible();
    await agent.evaluate(() => window.stopPresentation());
    await expect(button(sam, "Watch Studio agent’s stream")).toHaveCount(0);
    // The staged agent screen ended: the stage falls back to Riley's share and says so.
    await expect(sam.getByRole("status").filter({ hasText: "Studio agent’s screen ended. Showing Riley’s screen." })).toBeVisible();
    await expect(button(sam, "Watch Riley’s stream")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => screen.evaluate(video => video.currentTime)).toBeGreaterThan(0);
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    await site.close();
  }
});
