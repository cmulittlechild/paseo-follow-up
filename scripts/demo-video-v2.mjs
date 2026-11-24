// Records the take for Follow-up's demo video v2 (the edit itself lives in video/, a Remotion project):
// `npm run video:v2:take` through ~/paseo-harness/tools/harness-slot, then `npm --prefix video run render`.
// v1 (scripts/demo-video.mjs) bakes its cursor and caption band into the frames. v2 records the bare app instead, twice
// as sharp (1280×800 CSS px at 2×, so a 1.6× zoom stays crisp), and logs what the edit needs to animate: every pointer
// position, each press, the beats and the boxes the camera frames. Writes, to --out (default video/public/take/):
//   raw.mp4    the app at 2560×1600, 30 fps, at the take's own pacing (the app's waits squeezed, as in v1)
//   take.json  { fps, seconds, view, beats, pointer: [[t, x, y]], presses: [[t, x, y]], focus: [{ t, name, box }],
//              typing: [[from, to]] }: times in the video's seconds, positions in CSS px of the 1280×800 view
// Usage: node scripts/demo-video-v2.mjs [--out <dir>] [--as-version <X.Y.Z>] [--keep-frames]
//
// The take is v1's: Home with Needs you on top; Catch up (Allow, Skip, the recommended answer); what Follow-up sent
// back to agents by itself; a question to the Overseer from Home's search and its answer; Home again. Boot, fixture,
// synthetic names and the stitch's dead-time squeeze are v1's too (see its header). The pointer glides on a slight arc
// with minimum-jerk easing, as a hand moves, so the app's hover states follow the same path the edit draws.
//
// Needs PLAYWRIGHT_CORE, CHROMIUM (docs/testing.md) and FFMPEG (with libx264; video/'s ffmpeg-static works:
// FFMPEG=video/node_modules/ffmpeg-static/ffmpeg after `npm --prefix video ci`).
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { openHome, homeRow } from "./ui-home.mjs";
import { harness } from "./harness.mjs";
import { assertNoRealNames } from "./real-names.mjs";

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const log = (...a) => console.log("[take]", ...a);
function fail(message) { console.error(`demo-video-v2: ${message}`); process.exit(1); }

if (!process.env.PLAYWRIGHT_CORE || !existsSync(join(process.env.PLAYWRIGHT_CORE, "package.json"))) fail("set PLAYWRIGHT_CORE to a playwright-core directory");
if (!process.env.CHROMIUM || !existsSync(process.env.CHROMIUM)) fail("set CHROMIUM to a Chromium or chrome-headless-shell binary");
const FFMPEG = process.env.FFMPEG;
if (!FFMPEG || !existsSync(FFMPEG)) fail("set FFMPEG to an ffmpeg binary with libx264 (see the header)");
const out = resolve(arg("--out", "video/public/take"));
await harness();
const asVersion = arg("--as-version") ?? (await exec("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*", "--exclude", "*-*"])).stdout.trim().replace(/^v/, "");

const VIEW = { width: 1280, height: 800 };
const SCALE = 2;
const FPS = 30;
const VIEW_TIME = Date.parse("2026-03-04T12:00:00.000Z"); // screenshots.mjs: BASE + VIEW
const QUESTION = "What's blocking the billing release?";
const ANSWER = "Billing retries is waiting on you. Its agent asked whether declined cards should retry (Q1), and #142's test fails until that's settled. #143, the dunning email, is approved and stacked on #142, so both can merge once you answer.";

// ---------- page helpers (run in the browser): v1's, without the drawn cursor ----------
const INIT = () => {
  try { localStorage.setItem("@paseo:onboarding", JSON.stringify({ completedAt: "2026-03-04T09:00:00.000Z" })); localStorage.setItem("follow-up.whats-new.seen", "9.9.9"); } catch {}
};
const MODEL_LABEL = () => {
  const swap = root => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/Followup-fixture/i.test(n.data)) n.data = n.data.replace(/Followup-fixture · Fixture|Followup-fixture/gi, "Claude · Opus");
  };
  const start = () => { swap(document.body); new MutationObserver(ms => { for (const m of ms) swap(m.target.nodeType === 3 ? m.target.parentNode : m.target); }).observe(document.body, { subtree: true, childList: true, characterData: true }); };
  if (document.body) start(); else addEventListener("DOMContentLoaded", start, { once: true });
};
const HIDE_HARNESS_PROJECT = () => {
  const hide = () => {
    for (const row of document.querySelectorAll('[data-testid^="sidebar-project-row-"]')) {
      if (!(row.textContent ?? "").includes("overseer-home")) continue;
      const key = row.getAttribute("data-testid").slice("sidebar-project-row-".length);
      let block = row;
      for (let up = row.parentElement; up && up.querySelectorAll('[data-testid^="sidebar-project-row-"]').length === 1; up = up.parentElement) block = up;
      block.style.display = "none";
      for (const list of document.querySelectorAll(`[data-testid="sidebar-workspace-list-${key}"]`)) list.style.display = "none";
    }
  };
  const start = () => { hide(); new MutationObserver(hide).observe(document.body, { subtree: true, childList: true }); };
  if (document.body) start(); else addEventListener("DOMContentLoaded", start, { once: true });
};

// ---------- the log ----------
const now = () => Date.now() / 1000;
const live = []; // scripted spans, kept at full length by the stitch
const pointerLog = []; const pressLog = []; const focusLog = []; const typingLog = [];
async function scripted(work) { const a = now(); try { return await work(); } finally { live.push([a, now()]); } }
const rest = (page, ms) => scripted(() => page.waitForTimeout(ms));
let pointer = { x: VIEW.width * 0.86, y: VIEW.height * 0.9 };
async function moveTo(page, x, y) { await page.mouse.move(x, y); pointerLog.push([now(), x, y]); pointer = { x, y }; }
/** The camera's subject from now on: a box in CSS px (or null for the whole app), with how close to frame it. */
async function focus(name, target, { zoom } = {}) {
  let box = null;
  if (target && typeof target.boundingBox === "function") { await target.waitFor(); box = await target.boundingBox(); }
  else if (target) box = target;
  focusLog.push({ t: now(), name, box: box && { x: box.x, y: box.y, width: box.width, height: box.height }, zoom: zoom ?? null });
}

// ---------- motion: a hand, not a robot ----------
const minJerk = t => t * t * t * (10 - 15 * t + 6 * t * t);
let arcSide = 1;
/**
 * Glides the pointer on a shallow arc (a quadratic bezier bowed off the straight line by ~8% of the distance, sides
 * alternating) with minimum-jerk easing, the velocity profile of a human reach. Wall-clock driven, as in v1.
 */
async function glide(page, x, y, ms) {
  const from = pointer, dx = x - from.x, dy = y - from.y, d = Math.hypot(dx, dy);
  ms ??= Math.min(950, 380 + d * 0.45);
  const bow = Math.min(60, d * 0.08) * (arcSide = -arcSide);
  const cx = (from.x + x) / 2 - (dy / (d || 1)) * bow, cy = (from.y + y) / 2 + (dx / (d || 1)) * bow;
  const start = Date.now(), a = now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / ms), k = minJerk(t), u = 1 - k;
    await moveTo(page, u * u * from.x + 2 * u * k * cx + k * k * x, u * u * from.y + 2 * u * k * cy + k * k * y);
    if (t >= 1) break;
    await page.waitForTimeout(12);
  }
  live.push([a, now()]);
}
async function glideTo(page, locator, { ms, dx = 0.5 } = {}) {
  await locator.waitFor();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("glideTo: no box");
  await glide(page, box.x + box.width * dx, box.y + box.height / 2, ms);
  return box;
}
async function glideClick(page, locator, { ms, rest: restMs = 380, dx } = {}) {
  const box = await glideTo(page, locator, { ms, dx });
  await scripted(async () => {
    await page.waitForTimeout(restMs);
    pressLog.push([now(), pointer.x, pointer.y]);
    await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
  });
  return box;
}
const visible = locator => locator.filter({ visible: true }).first();

// ---------- run ----------
const work = await fs.mkdtemp(join(tmpdir(), "follow-take-"));
const frameDir = join(work, "frames");
let shots = null; let browser = null; let client = null;
const cleanup = async () => {
  await browser?.close().catch(() => {});
  await client?.close().catch(() => {});
  if (shots && shots.exitCode === null) {
    shots.kill("SIGINT");
    for (let i = 0; i < 300 && shots.exitCode === null; i++) await new Promise(r => setTimeout(r, 100));
    if (shots.exitCode === null) shots.kill("SIGKILL");
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void cleanup().finally(() => process.exit(130)); });

try {
  await fs.mkdir(frameDir, { recursive: true }); await fs.mkdir(out, { recursive: true });
  log(`booting the fixture (Home reads v${asVersion})`);
  const boot = () => {
    shots = spawn(process.execPath, ["scripts/screenshots.mjs", "--only", "home", "--overseer-review", "--keep", "--as-version", asVersion, "--out", join(work, "shots")], { stdio: ["ignore", "pipe", "inherit"] });
    return new Promise((resolveKept, reject) => {
      const lines = createInterface({ input: shots.stdout });
      lines.on("line", line => { if (line.startsWith("{")) resolveKept(JSON.parse(line)); else console.log(line); });
      shots.on("exit", code => reject(new Error(`screenshots.mjs exited (${code}) before the fixture was up`)));
    });
  };
  const kept = await boot().catch(error => { log(`${error.message}; booting once more`); return boot(); });
  const { root, home, port } = kept;
  const ws = key => kept.workspaces.find(w => w.key === key);
  const origin = `http://127.0.0.1:${port}`;
  const serverId = (await fs.readFile(join(home, "server-id"), "utf8")).trim();
  await fs.writeFile(join(root, "clock-offset"), JSON.stringify({ fake: VIEW_TIME, real: Date.now(), rate: 0.001 }));
  await new Promise(r => setTimeout(r, 400));
  client = new DaemonClient({ url: `ws://127.0.0.1:${port}/ws`, clientId: "follow-take", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true });
  await client.connect();
  const call = (method, input) => client.invokePluginRpc("follow-up", method, input);
  const overseer = await call("follow.overseer-start", {});
  if (!overseer.agentId) throw new Error(`the Overseer didn't start: ${JSON.stringify(overseer)}`);
  const scriptsFile = join(home, "fixture-scripts.json");
  const scripts = JSON.parse(await fs.readFile(scriptsFile, "utf8").catch(() => "{}"));
  scripts[`agent:${overseer.agentId}`] = [{ gate: "overseer" }, { item: { type: "assistant_message", text: ANSWER } }];
  await fs.writeFile(scriptsFile, JSON.stringify(scripts));
  log(`fixture up on ${origin}; Overseer ${overseer.agentId}`);

  const { chromium } = createRequire(join(process.env.PLAYWRIGHT_CORE, "package.json"))("playwright-core");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, colorScheme: "light", timezoneId: "UTC", locale: "en-US" });
  for (const script of [INIT, MODEL_LABEL, HIDE_HARNESS_PROJECT]) await context.addInitScript(script);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.clock.setFixedTime(VIEW_TIME);
  await openHome(page, { origin, serverId });
  const catchUp = visible(page.getByRole("button", { name: /^Catch up on \d+ things? that need you/ }));
  await catchUp.waitFor();
  await visible(page.getByText("Ask about any workspace or agent")).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  await moveTo(page, pointer.x, pointer.y);
  assertNoRealNames(await page.evaluate(() => document.body.innerText), "Home");
  if (await page.locator('[data-testid^="sidebar-project-row-"]').filter({ hasText: "overseer-home", visible: true }).count()) throw new Error("the harness's overseer-home project still shows in the sidebar");

  // The take.
  const cdp = await context.newCDPSession(page);
  const frames = []; const marks = {}; let writes = Promise.resolve();
  cdp.on("Page.screencastFrame", f => {
    const file = join(frameDir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    frames.push({ t: f.metadata.timestamp, file });
    writes = writes.then(() => fs.writeFile(file, Buffer.from(f.data, "base64")));
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const mark = name => { marks[name] = now(); log(`beat: ${name}`); };
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: VIEW.width * SCALE, maxHeight: VIEW.height * SCALE, everyNthFrame: 1 });
  await moveTo(page, pointer.x + 1, pointer.y);
  mark("home");
  await focus("home", null);
  await rest(page, 1300);
  await glide(page, VIEW.width * 0.6, VIEW.height * 0.48, 760);
  await rest(page, 250);
  await focus("catchup-button", catchUp, { zoom: 1.45 });
  await glideClick(page, catchUp, { ms: 820 });
  mark("catchup");
  const card = page.locator("[data-catch-up-card]");
  const allow = visible(card.getByRole("button", { name: /^Allow/ }));
  await allow.waitFor();
  await focus("card", visible(card));
  await rest(page, 800);
  await glideClick(page, allow, { rest: 550 });
  await visible(card.getByText(/#151/)).waitFor();
  await focus("card", visible(card));
  await rest(page, 700);
  await glideClick(page, visible(page.getByRole("button", { name: /^Skip this (?!workspace)/ })), { rest: 450 });
  const recommended = visible(card.getByRole("radio").filter({ hasText: "Recommended" }));
  await recommended.waitFor();
  await focus("card", visible(card));
  await rest(page, 900);
  await glideClick(page, recommended, { rest: 450, dx: 0.2 });
  await rest(page, 300);
  const sends = page.getByRole("button", { name: /^Send to agent/ }).filter({ visible: true });
  await sends.first().waitFor();
  const tops = await sends.evaluateAll(els => els.map(e => e.getBoundingClientRect().top + window.scrollY));
  await glideClick(page, sends.nth(tops.indexOf(Math.min(...tops))), { rest: 400 });
  await rest(page, 900);
  const leave = visible(page.getByRole("button", { name: /^Leave Catch up/ }));
  await focus("leave", leave, { zoom: 1.2 });
  await glideClick(page, leave, { ms: 700, rest: 350 });
  await visible(page.getByText(/^Done while you were away$/i)).waitFor();
  mark("repairs");
  await focus("home", null);
  await rest(page, 400);
  const repairs = visible(page.getByText(/^Sent 2 repairs to the main agent/));
  await focus("repairs", repairs, { zoom: 1.5 });
  await glideTo(page, repairs, { ms: 800, dx: 0.3 });
  await rest(page, 1200);
  const viewsRow = await homeRow(page, ws("views").title);
  await focus("repairs-row", viewsRow, { zoom: 1.5 });
  await glideClick(page, viewsRow, { ms: 700, rest: 400, dx: 0.25 });
  await rest(page, 900);
  await focus("home", null);
  await rest(page, 1300);
  mark("overseer");
  const search = visible(page.getByRole("textbox", { name: /^Search,? or ask the Overseer$/ }));
  await focus("search", search, { zoom: 1.6 });
  await glideClick(page, search, { ms: 750, rest: 280, dx: 0.3 });
  await rest(page, 250);
  const typeFrom = now();
  await scripted(() => search.pressSequentially(QUESTION, { delay: 42 }));
  typingLog.push([typeFrom, now()]);
  const askRow = visible(page.getByRole("button", { name: /^Ask the Overseer: / }));
  await askRow.waitFor();
  await rest(page, 500);
  await glideClick(page, askRow, { ms: 600, rest: 400, dx: 0.35 });
  await visible(page.getByText(QUESTION)).waitFor();
  await focus("overseer-panel", visible(page.getByText(QUESTION)), { zoom: 1.35 });
  await rest(page, 1000);
  await fs.writeFile(join(home, "fixture-gate-overseer"), "");
  const answer = visible(page.getByText(/^Billing retries is waiting on you/));
  await answer.waitFor({ timeout: 30000 });
  await focus("answer", answer, { zoom: 1.45 });
  await rest(page, 2800);
  mark("end");
  // Back to the Morning brief, the pane Home opened on, so the loop's last frame is its first.
  await focus("home", null);
  await glideClick(page, visible(page.getByText("Morning brief", { exact: true })), { ms: 800, rest: 300, dx: 0.5 });
  await rest(page, 500);
  await glide(page, VIEW.width * 0.86, VIEW.height * 0.9, 900);
  await rest(page, 1700);
  mark("stop");
  await cdp.send("Page.stopScreencast");
  await writes;
  assertNoRealNames(await page.evaluate(() => document.body.innerText), "the last frame");
  log(`${frames.length} frames over ${(marks.stop - marks.home).toFixed(1)} s of wall clock`);

  // The stitch: v1's. Scripted spans keep their length, each wait for the app at most DEAD_MAX; frames and every
  // logged time go through the same map.
  const DEAD_MAX = 0.3;
  const t0 = Math.min(frames[0].t, marks.home), t1 = marks.stop;
  const spans = live.map(([a, b]) => [Math.max(a, t0), Math.min(b, t1)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
    .reduce((m, [a, b]) => { const l = m.at(-1); if (l && a <= l[1]) l[1] = Math.max(l[1], b); else m.push([a, b]); return m; }, []);
  const pieces = []; let cursor = t0;
  for (const [a, b] of spans) { if (a > cursor) pieces.push([cursor, a, Math.min(a - cursor, DEAD_MAX)]); pieces.push([a, b, b - a]); cursor = b; }
  if (t1 > cursor) pieces.push([cursor, t1, Math.min(t1 - cursor, DEAD_MAX)]);
  const PACE = 1.08;
  const remap = t => { let o = 0; for (const [a, b, len] of pieces) { if (t >= b) { o += len; continue; } if (t > a) o += (t - a) / (b - a) * len; break; } return o / PACE; };
  const outT = [...frames.map(f => remap(f.t)), remap(t1)];
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.0005, outT[i + 1] - outT[i]).toFixed(4)}`);
  list.push(`file '${frames.at(-1).file}'`);
  await fs.writeFile(join(work, "frames.txt"), list.join("\n") + "\n");
  const seconds = outT.at(-1);
  const raw = join(out, "raw.mp4");
  await exec(FFMPEG, ["-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(work, "frames.txt"),
    "-vf", `fps=${FPS},scale=${VIEW.width * SCALE}:${VIEW.height * SCALE}:flags=lanczos,setsar=1`, "-t", seconds.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p", "-g", "15", "-movflags", "+faststart", raw], { maxBuffer: 1 << 24 });
  const r3 = n => Math.round(n * 1000) / 1000;
  const take = {
    fps: FPS, seconds: r3(seconds), view: VIEW, scale: SCALE,
    beats: Object.fromEntries(Object.entries(marks).map(([k, t]) => [k, r3(remap(t))])),
    pointer: pointerLog.filter(([t]) => t <= t1).map(([t, x, y]) => [r3(remap(t)), r3(x), r3(y)]),
    presses: pressLog.map(([t, x, y]) => [r3(remap(t)), r3(x), r3(y)]),
    focus: focusLog.map(f => ({ ...f, t: r3(remap(f.t)) })),
    typing: typingLog.map(([a, b]) => [r3(remap(a)), r3(remap(b))]),
  };
  await fs.writeFile(join(out, "take.json"), JSON.stringify(take, null, 1));
  log(`raw ${raw} (${seconds.toFixed(1)} s); take ${join(out, "take.json")}`);
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await cleanup();
  if (argv.includes("--keep-frames") || process.exitCode) log(`kept ${work}`); else await fs.rm(work, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
