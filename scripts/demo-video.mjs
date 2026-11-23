// Records Follow-up's 20-30 s demo video (plugin page and README) from the real UI on fixture data:
// `npm run video -- --out <dir>` through ~/paseo-harness/tools/harness-slot. Writes follow-up-demo.mp4 (H.264,
// 1920×1200, faststart), follow-up-demo-poster.png (its first second), follow-up-demo.webp (an animated fallback at
// 960×600) and frames/ (one PNG every 2 s, to review). The committed copies sit in docs/screenshots/, left out of the npm
// package (package.json files: !docs/screenshots/follow-up-demo*); see docs/testing.md "Demo video".
// Usage: node scripts/demo-video.mjs [--out <dir>] [--as-version <X.Y.Z>] [--keep-frames]
//
// The take, in one 16:10 frame: Home with Needs you on top; Catch up, where one click allows a permission, the next
// card is skipped and a question is answered with its recommended option; what Follow-up sent to agents by itself
// while you were away; a question to the Overseer from Home's search, and its answer; Home again.
// A caption band under the app names each step (Inter, #222126 and the icon's lilac #B79CF0).
//
// Boot: `scripts/screenshots.mjs --only home --overseer-review --keep` (its isolated daemon, fixture provider, fake
// gh and README seed: synthetic names only), read from its JSON line, stopped with SIGINT at the end. Then the daemon
// clock is set to the shots' view time, the Overseer starts on the fixture provider, and its answer waits on a gate
// so it lands a beat after the ask, as a real one would.
// Recording: a CDP screencast of the page (sharper than Playwright's VP8 video) with a drawn cursor and click rings,
// stitched by ffmpeg at the frames' own timestamps, so the pacing is the real pacing.
//
// Needs PLAYWRIGHT_CORE and CHROMIUM (docs/testing.md), and FFMPEG: an ffmpeg with libx264 and libwebp (the box has
// none; a pinned ffmpeg-static in a scratch folder works: npm i ffmpeg-static@5.3.0, then FFMPEG=<dir>/node_modules/ffmpeg-static/ffmpeg).
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync } from "node:fs";
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
const log = (...a) => console.log("[video]", ...a);
function fail(message) { console.error(`demo-video: ${message}`); process.exit(1); }

if (!process.env.PLAYWRIGHT_CORE || !existsSync(join(process.env.PLAYWRIGHT_CORE, "package.json"))) fail("set PLAYWRIGHT_CORE to a playwright-core directory");
if (!process.env.CHROMIUM || !existsSync(process.env.CHROMIUM)) fail("set CHROMIUM to a Chromium or chrome-headless-shell binary");
const FFMPEG = process.env.FFMPEG;
if (!FFMPEG || !existsSync(FFMPEG)) fail("set FFMPEG to an ffmpeg binary with libx264 and libwebp (see the header)");
const out = resolve(arg("--out", ".demo-video"));
await harness();
// Home reads the latest stable version, as the README images do: the video never shows a beta number.
const asVersion = arg("--as-version") ?? (await exec("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*", "--exclude", "*-*"])).stdout.trim().replace(/^v/, "");

// ---------- the frame ----------
const W = 1920, H = 1200, BAND = 180;
const SCALE = 1.5; // device pixels per CSS pixel: the app is laid out at 1280×680, captured at 1920×1020
const VIEW = { width: W / SCALE, height: Math.round((H - BAND) / SCALE) };
const APP_H = Math.round(VIEW.height * SCALE);
const VIEW_TIME = Date.parse("2026-03-04T12:00:00.000Z"); // screenshots.mjs: BASE + VIEW
const CAPTIONS = {
  home: "Every agent, one inbox.",
  catchup: "Answer in seconds.",
  repairs: "Fixes go back by themselves.",
  overseer: "Ask across every workspace.",
  end: "Every agent, one inbox.",
};
const QUESTION = "What's blocking the billing release?";
const ANSWER = "Billing retries is waiting on you. Its agent asked whether declined cards should retry (Q1), and #142's test fails until that's settled. #143, the dunning email, is approved and stacked on #142, so both can merge once you answer.";

// ---------- page helpers (run in the browser) ----------
/** A drawn cursor (headless Chromium has none): an arrow that follows mousemove and a lilac ring on each press. */
const CURSOR = () => {
  if (window.__demoCursor) return; window.__demoCursor = true;
  const install = () => {
    const arrow = document.createElement("div");
    arrow.style.cssText = "position:fixed;top:0;left:0;width:24px;height:28px;pointer-events:none;z-index:2147483647;opacity:0;will-change:transform;transition:transform 40ms linear,opacity 160ms ease-out";
    arrow.innerHTML = '<svg width="24" height="28" viewBox="0 0 22 26" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))"><path d="M3 2.2 L3 20.4 L7.7 15.9 L10.7 22.9 L13.6 21.7 L10.6 14.8 L17.2 14.4 Z" fill="#ffffff" stroke="#222126" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    const rings = document.createElement("div");
    rings.style.cssText = "position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646";
    document.documentElement.append(rings, arrow);
    let x = -100, y = -100;
    const place = s => { arrow.style.transform = `translate(${x - 3}px,${y - 2}px)${s ? ` scale(${s})` : ""}`; };
    addEventListener("mousemove", e => { x = e.clientX; y = e.clientY; arrow.style.opacity = "1"; place(); }, true);
    addEventListener("mousedown", () => {
      place(0.86);
      const r = document.createElement("div");
      r.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:rgba(183,156,240,.45);box-shadow:0 0 0 2px #B79CF0;transition:transform 450ms ease-out,opacity 450ms ease-out`;
      rings.append(r); requestAnimationFrame(() => { r.style.transform = "scale(3.4)"; r.style.opacity = "0"; }); setTimeout(() => r.remove(), 500);
    }, true);
    addEventListener("mouseup", () => place(), true);
  };
  if (document.documentElement) install(); else addEventListener("DOMContentLoaded", install, { once: true });
};
/** First run done and What's new seen, as on a developer's own machine. */
const INIT = () => {
  try { localStorage.setItem("@paseo:onboarding", JSON.stringify({ completedAt: "2026-03-04T09:00:00.000Z" })); localStorage.setItem("follow-up.whats-new.seen", "9.9.9"); } catch {}
};
/**
 * The Overseer runs on the harness's fixture provider, whose label is a test name. Show the model a developer would
 * see (the Overseer's default, Claude's newest Opus) instead; nothing else on screen is touched.
 */
const MODEL_LABEL = () => {
  const swap = root => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/Followup-fixture/i.test(n.data)) n.data = n.data.replace(/Followup-fixture · Fixture|Followup-fixture/gi, "Claude · Opus");
  };
  const start = () => { swap(document.body); new MutationObserver(ms => { for (const m of ms) swap(m.target.nodeType === 3 ? m.target.parentNode : m.target); }).observe(document.body, { subtree: true, childList: true, characterData: true }); };
  if (document.body) start(); else addEventListener("DOMContentLoaded", start, { once: true });
};

/**
 * Starting the Overseer makes the harness add its home as a project ("overseer-home") to Paseo's sidebar, which the
 * screenshot fixture (and the slides) never show. Hide that one project block, row and workspace list; nothing else.
 */
const HIDE_HARNESS_PROJECT = () => {
  const hide = () => {
    for (const row of document.querySelectorAll('[data-testid^="sidebar-project-row-"]')) {
      if (!(row.textContent ?? "").includes("overseer-home")) continue; // the row reads "<avatar letter>overseer-home"
      const key = row.getAttribute("data-testid").slice("sidebar-project-row-".length);
      // The project's block: the widest ancestor that holds this project's row and no other project's.
      let block = row;
      for (let up = row.parentElement; up && up.querySelectorAll('[data-testid^="sidebar-project-row-"]').length === 1; up = up.parentElement) block = up;
      block.style.display = "none";
      for (const list of document.querySelectorAll(`[data-testid="sidebar-workspace-list-${key}"]`)) list.style.display = "none";
    }
  };
  const start = () => { hide(); new MutationObserver(hide).observe(document.body, { subtree: true, childList: true }); };
  if (document.body) start(); else addEventListener("DOMContentLoaded", start, { once: true });
};

// ---------- motion ----------
// The first frame is the poster: the pointer starts in the empty foot of the right pane, off every row.
let pointer = { x: VIEW.width * 0.86, y: VIEW.height * 0.9 };
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
/**
 * Glides the pointer along an eased path (page.mouse.move's steps are linear and look robotic). Positions follow the
 * wall clock, so a glide takes `ms` however slow each move is on a loaded machine.
 */
async function glide(page, x, y, ms = 650) {
  const from = pointer, start = Date.now(), a = now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / ms), k = ease(t);
    await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
    if (t >= 1) break;
    await page.waitForTimeout(16);
  }
  live.push([a, now()]);
  pointer = { x, y };
}
async function glideTo(page, locator, { ms = 540, dx = 0.5 } = {}) {
  await locator.waitFor();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("glideTo: no box");
  await glide(page, box.x + box.width * dx, box.y + box.height / 2, ms);
}
/** Glide, rest on the target so a viewer sees what is about to be pressed, then press. */
async function glideClick(page, locator, { ms = 540, rest = 450, dx } = {}) {
  await glideTo(page, locator, { ms, dx });
  await scripted(async () => { await page.waitForTimeout(rest); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up(); });
}
const visible = locator => locator.filter({ visible: true }).first();
/**
 * The take's scripted time: glides, rests, presses and typing. Everything between them is the app catching up (a
 * daemon reply, a render on a loaded machine), which the stitch shortens to DEAD_MAX, so the video keeps the scripted
 * pacing however slow the machine was.
 */
const live = [];
const now = () => Date.now() / 1000;
async function scripted(work) { const a = now(); try { return await work(); } finally { live.push([a, now()]); } }
const rest = (page, ms) => scripted(() => page.waitForTimeout(ms));

// ---------- run ----------
const work = await fs.mkdtemp(join(tmpdir(), "follow-video-"));
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
  // 1. The fixture: screenshots.mjs's isolated daemon and README seed, kept running.
  log(`booting the fixture (Home reads v${asVersion})`);
  // One retry: on a loaded machine the fixture's plugin install can time out.
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
  // 2. The daemon's clock at the view time, crawling (screenshots.mjs setDaemonClock), then the Overseer, scripted.
  await fs.writeFile(join(root, "clock-offset"), JSON.stringify({ fake: VIEW_TIME, real: Date.now(), rate: 0.001 }));
  await new Promise(r => setTimeout(r, 400));
  client = new DaemonClient({ url: `ws://127.0.0.1:${port}/ws`, clientId: "follow-video", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true });
  await client.connect();
  const call = (method, input) => client.invokePluginRpc("follow-up", method, input);
  const overseer = await call("follow.overseer-start", {});
  if (!overseer.agentId) throw new Error(`the Overseer didn't start: ${JSON.stringify(overseer)}`);
  const scriptsFile = join(home, "fixture-scripts.json");
  const scripts = JSON.parse(await fs.readFile(scriptsFile, "utf8").catch(() => "{}"));
  scripts[`agent:${overseer.agentId}`] = [{ gate: "overseer" }, { item: { type: "assistant_message", text: ANSWER } }];
  await fs.writeFile(scriptsFile, JSON.stringify(scripts));
  log(`fixture up on ${origin}; Overseer ${overseer.agentId}`);

  // 3. The browser: light, 16:10 minus the caption band, real motion.
  const { chromium } = createRequire(join(process.env.PLAYWRIGHT_CORE, "package.json"))("playwright-core");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, colorScheme: "light", timezoneId: "UTC", locale: "en-US" });
  for (const script of [INIT, CURSOR, MODEL_LABEL, HIDE_HARNESS_PROJECT]) await context.addInitScript(script);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.clock.setFixedTime(VIEW_TIME);
  await openHome(page, { origin, serverId });
  const catchUp = visible(page.getByRole("button", { name: /^Catch up on \d+ things? that need you/ }));
  await catchUp.waitFor();
  await visible(page.getByText("Ask about any workspace or agent")).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500); // fonts, avatars and the first PR chips settle before the first frame
  await page.mouse.move(pointer.x, pointer.y);
  assertNoRealNames(await page.evaluate(() => document.body.innerText), "Home");
  if (await page.locator('[data-testid^="sidebar-project-row-"]').filter({ hasText: "overseer-home", visible: true }).count()) throw new Error("the harness's overseer-home project still shows in the sidebar");

  // 4. The take.
  const cdp = await context.newCDPSession(page);
  const frames = []; const marks = {}; let writes = Promise.resolve();
  cdp.on("Page.screencastFrame", f => {
    const file = join(frameDir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    frames.push({ t: f.metadata.timestamp, file });
    writes = writes.then(() => fs.writeFile(file, Buffer.from(f.data, "base64")));
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const mark = name => { marks[name] = Date.now() / 1000; log(`beat: ${name}`); };
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: W, maxHeight: APP_H, everyNthFrame: 1 });
  // A first frame even if nothing moves yet.
  await page.mouse.move(pointer.x + 1, pointer.y);
  mark("home");
  // Home: Needs you on top. The cursor drifts in, then goes to Catch up.
  await rest(page, 1400);
  await glide(page, VIEW.width * 0.62, VIEW.height * 0.5, 700);
  await rest(page, 300);
  await glideClick(page, catchUp, { ms: 800 });
  mark("catchup");
  const card = page.locator("[data-catch-up-card]");
  // Card 1: Search filters asks to run a staging migration. Allow, in one click.
  const allow = visible(card.getByRole("button", { name: /^Allow/ }));
  await allow.waitFor();
  await rest(page, 800);
  await glideClick(page, allow, { rest: 650 });
  // Card 2 slides in (#151 is approved): skip it, it comes back after the rest.
  await visible(card.getByText(/#151/)).waitFor();
  await rest(page, 700);
  await glideClick(page, visible(page.getByRole("button", { name: /^Skip this (?!workspace)/ })), { rest: 500 });
  // Card 3: Contact import's question. Pick the recommended answer and send it.
  const recommended = visible(card.getByRole("radio").filter({ hasText: "Recommended" }));
  await recommended.waitFor();
  await rest(page, 900);
  await glideClick(page, recommended, { rest: 500, dx: 0.2 });
  await rest(page, 350);
  // The question's own Send: the topmost one (the move bar repeats it below the fold on a short window).
  const sends = page.getByRole("button", { name: /^Send to agent/ }).filter({ visible: true });
  await sends.first().waitFor();
  const tops = await sends.evaluateAll(els => els.map(e => e.getBoundingClientRect().top + window.scrollY));
  await glideClick(page, sends.nth(tops.indexOf(Math.min(...tops))), { rest: 450 });
  await rest(page, 1000); // the next card slides in
  await glideClick(page, visible(page.getByRole("button", { name: /^Leave Catch up/ })), { ms: 700, rest: 400 });
  // Home: what went back to agents by itself while you were away, then one of those workspaces.
  await visible(page.getByText(/^Done while you were away$/i)).waitFor();
  mark("repairs");
  await rest(page, 500);
  await glideTo(page, visible(page.getByText(/^Sent 2 repairs to the main agent/)), { ms: 800, dx: 0.3 });
  await rest(page, 1200);
  await glideClick(page, await homeRow(page, ws("views").title), { ms: 800, rest: 450, dx: 0.25 });
  await rest(page, 2300);
  // The Overseer, from Home's search.
  mark("overseer");
  const search = visible(page.getByRole("textbox", { name: /^Search,? or ask the Overseer$/ }));
  await glideClick(page, search, { ms: 750, rest: 300, dx: 0.3 });
  await rest(page, 250);
  await scripted(() => search.pressSequentially(QUESTION, { delay: 38 }));
  const askRow = visible(page.getByRole("button", { name: /^Ask the Overseer: / }));
  await askRow.waitFor();
  await rest(page, 600);
  await glideClick(page, askRow, { ms: 600, rest: 450, dx: 0.35 });
  await visible(page.getByText(QUESTION)).waitFor();
  await rest(page, 1000); // the Overseer "thinks", then answers
  await fs.writeFile(join(home, "fixture-gate-overseer"), "");
  await visible(page.getByText(/^Billing retries is waiting on you/)).waitFor({ timeout: 30000 });
  await rest(page, 2300);
  // Home again, the same inbox it opened on.
  mark("end");
  await glide(page, VIEW.width * 0.5, VIEW.height * 0.3, 900);
  await rest(page, 1500);
  mark("stop");
  await cdp.send("Page.stopScreencast");
  await writes;
  assertNoRealNames(await page.evaluate(() => document.body.innerText), "the last frame");
  log(`${frames.length} frames over ${(marks.stop - marks.home).toFixed(1)} s of wall clock`);

  // 5. Captions: one PNG band per beat.
  const capPage = await (await browser.newContext({ viewport: { width: W, height: BAND }, deviceScaleFactor: 1 })).newPage();
  const icon = (await fs.readFile("assets/icon.svg", "utf8")).replace(/<\?xml[^>]*>/, "");
  const capFiles = {};
  for (const [key, text] of Object.entries(CAPTIONS)) {
    await capPage.setContent(`<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@600&display=block" rel="stylesheet"><style>
      html,body{margin:0;width:${W}px;height:${BAND}px;background:#222126;overflow:hidden}
      .bar{display:flex;align-items:center;gap:36px;height:100%;padding:0 72px;box-sizing:border-box;font-family:Inter,"Liberation Sans",Arial,sans-serif;-webkit-font-smoothing:antialiased}
      .icon{width:92px;height:92px;flex:none}.icon svg{width:100%;height:100%;display:block}
      .text{font-size:74px;font-weight:600;letter-spacing:-0.025em;color:#F4F2F7;white-space:nowrap}
      .rule{position:absolute;top:0;left:0;right:0;height:3px;background:#B79CF0;opacity:.85}
    </style></head><body><div class="rule"></div><div class="bar"><div class="icon">${icon}</div><div class="text">${text}</div></div></body></html>`);
    await capPage.evaluate(() => document.fonts.ready);
    capFiles[key] = join(work, `cap-${key}.png`);
    await capPage.screenshot({ path: capFiles[key] });
  }

  // 6. Stitch: each frame for as long as it was on screen, the band under it, captions by beat.
  // The timeline: scripted spans keep their length, each gap between them (the app catching up) at most DEAD_MAX,
  // squeezed evenly. Frames and beat marks go through the same map.
  const DEAD_MAX = 0.3;
  const t0 = Math.min(frames[0].t, marks.home), t1 = marks.stop;
  const spans = live.map(([a, b]) => [Math.max(a, t0), Math.min(b, t1)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
    .reduce((m, [a, b]) => { const l = m.at(-1); if (l && a <= l[1]) l[1] = Math.max(l[1], b); else m.push([a, b]); return m; }, []);
  const pieces = []; let cursor = t0;
  for (const [a, b] of spans) { if (a > cursor) pieces.push([cursor, a, Math.min(a - cursor, DEAD_MAX)]); pieces.push([a, b, b - a]); cursor = b; }
  if (t1 > cursor) pieces.push([cursor, t1, Math.min(t1 - cursor, DEAD_MAX)]);
  const remap = t => { let o = 0; for (const [a, b, len] of pieces) { if (t >= b) { o += len; continue; } if (t > a) o += (t - a) / (b - a) * len; break; } return o; };
  // The take plays at PACE: a touch quicker than it was driven, still a person's speed, so the whole loop fits 30 s.
  const PACE = 1.15;
  const out_t = [...frames.map(f => remap(f.t) / PACE), remap(t1) / PACE];
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.0005, out_t[i + 1] - out_t[i]).toFixed(4)}`);
  list.push(`file '${frames.at(-1).file}'`);
  await fs.writeFile(join(work, "frames.txt"), list.join("\n") + "\n");
  const beats = ["home", "catchup", "repairs", "overseer", "end"];
  const at = key => Math.max(0, remap(marks[key]) / PACE);
  const total = out_t.at(-1);
  const inputs = ["-f", "concat", "-safe", "0", "-i", join(work, "frames.txt"), ...beats.flatMap(k => ["-loop", "1", "-i", capFiles[k]])];
  let filter = `[0:v]fps=30,scale=${W}:${APP_H}:flags=lanczos,pad=${W}:${H}:0:0:color=0x222126,setsar=1[v0]`;
  beats.forEach((k, i) => {
    const from = i === 0 ? 0 : at(k), to = i + 1 < beats.length ? at(beats[i + 1]) : total + 1;
    filter += `;[v${i}][${i + 1}:v]overlay=0:${APP_H}:shortest=1:enable='between(t,${from.toFixed(3)},${to.toFixed(3)})'[v${i + 1}]`;
  });
  const mp4 = join(out, "follow-up-demo.mp4");
  await exec(FFMPEG, ["-nostdin", "-v", "error", "-y", ...inputs, "-filter_complex", filter, "-map", `[v${beats.length}]`, "-t", total.toFixed(3),
    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", mp4], { maxBuffer: 1 << 24 });
  const poster = join(out, "follow-up-demo-poster.png");
  await exec(FFMPEG, ["-nostdin", "-v", "error", "-y", "-ss", "0.8", "-i", mp4, "-frames:v", "1", poster]);
  const webp = join(out, "follow-up-demo.webp");
  await exec(FFMPEG, ["-nostdin", "-v", "error", "-y", "-i", mp4, "-vf", "fps=12,scale=960:600:flags=lanczos", "-c:v", "libwebp_anim", "-lossless", "0", "-q:v", "70", "-compression_level", "2", "-loop", "0", webp]);
  const review = join(out, "frames");
  await fs.rm(review, { recursive: true, force: true }); await fs.mkdir(review);
  await exec(FFMPEG, ["-nostdin", "-v", "error", "-y", "-i", mp4, "-vf", "fps=0.5", join(review, "t%02d.png")]);
  const size = async p => `${((await fs.stat(p)).size / 1048576).toFixed(2)} MB`;
  writeFileSync(join(out, "demo-video.json"), JSON.stringify({ version: asVersion, seconds: Number(total.toFixed(2)), beats: Object.fromEntries(beats.map(k => [k, Number(at(k).toFixed(2))])) }, null, 2));
  log(`mp4 ${mp4} (${await size(mp4)}, ${total.toFixed(1)} s); poster ${poster}; webp ${webp} (${await size(webp)}); review frames ${review}`);
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await cleanup();
  if (argv.includes("--keep-frames") || process.exitCode) log(`kept ${work}`); else await fs.rm(work, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
