// Renders Follow-up's slide set: the README's cover and the plugin page's media (paseo-plugin.json `media`, cover
// first). Every slide is 16:10 (1920×1200 at 2×), because Paseo's plugin page shows media as 288×180 tiles and its
// list card shows the first one at aspect 1.6. Same frame and colours on every slide (assets/icon.svg: tile #222126,
// accent dot #B79CF0): Follow-up's icon, name and a "Paseo plugin" pill at the top of the text column.
//   - follow-up-slide-1-cover.png: a two-line headline (the second line in the accent), a subline, pills naming the
//     pillars and an honest footnote; a real Home screenshot in a desktop window and Catch up in an overlapping phone.
//   - follow-up-slide-2…6: one feature each, a short headline and one plain line saying what it does for you, beside
//     that feature's real element zoomed in, cropped from a 6× render and never upscaled. The sides alternate through
//     the carousel: slide 2 has its text on the right and the element on the left, slide 3 the other way round, and so on.
// An HTML composition rendered with headless Chromium. The sources come from `scripts/screenshots.mjs --only frames`
// (synthetic data only); scripts/readme-shots.sh runs both.
//
//   node scripts/cover.mjs --from <frames out dir> --out <dir> [--only cover,decision,…]
//     [--headline "First line|Second line"] [--subline "…"] (or COVER_HEADLINE, COVER_SUBLINE)
//
// Needs PLAYWRIGHT_CORE and CHROMIUM (docs/testing.md). The font (Inter) loads from Google Fonts; without a network
// the system sans-serif stands in. Run it through ~/paseo-harness/tools/harness-slot (it starts a browser).
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { harness } from "./harness.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const fail = message => { console.error(`cover: ${message}`); process.exit(1); };
const from = arg("--from"), outDir = arg("--out");
if (!from || !outDir) fail("needs --from <frames dir> --out <dir>");
if (!process.env.PLAYWRIGHT_CORE || !process.env.CHROMIUM) fail("set PLAYWRIGHT_CORE and CHROMIUM (docs/testing.md)");
const W = 1920, H = 1200;

/** The slides, in plugin-page order. `src` names a file of the frames run (follow-up-<src>.png). */
export const SLIDES = [
  { name: "1-cover", kind: "cover",
    headline: process.env.COVER_HEADLINE || "Every agent,|one inbox.",
    subline: process.env.COVER_SUBLINE || "Your agents work in parallel. Your attention span doesn't.",
    pills: ["Inbox", "Overseer", "Catch up", "After the merge"],
    desktop: "cover-home", phone: "catch-up-phone-light" },
  { name: "2-decision", headline: "Answer|in seconds", line: "Agents always tell you exactly what they need from YOU", src: "slide-decision" },
  { name: "3-overseer", headline: "Ask across|every workspace", line: "One agent knows them all. Ask it anything from Home's search box.", src: "slide-overseer" },
  { name: "4-repairs", headline: "Fixes go back|by themselves", line: "Failed checks, conflicts and review comments go to the agent that made the PR.", src: "slide-repairs" },
  { name: "5-deploy", headline: "It keeps|following up", line: "Tasks come due after the merge or the deploy, and go back to their agent.", src: "slide-deploy" },
  { name: "6-catch-up", headline: "Catch up|from your phone", line: "Inspired by Slack: a catch-up mode to swipe through every task that needs you.", src: "slide-catch-up", phone: true },
];
if (arg("--headline")) SLIDES[0].headline = arg("--headline");
if (arg("--subline")) SLIDES[0].subline = arg("--subline");
const onlyNames = arg("--only")?.split(",");
const footnote = "Actual Follow-up screens with sample data, in the Paseo web app. The phone frame shows the same web app at phone size.";

const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const file = name => { const p = join(resolve(from), `follow-up-${name}.png`); if (!existsSync(p)) fail(`no ${p}; run screenshots.mjs --only frames first`); return p; };
const data = name => `data:image/png;base64,${readFileSync(file(name)).toString("base64")}`;
const size = name => { const b = readFileSync(file(name)); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
const icon = `data:image/svg+xml;base64,${readFileSync(new URL("../assets/icon.svg", import.meta.url)).toString("base64")}`;
const headline = h => { const [a, b = ""] = h.split("|"); return `<h1><span>${esc(a)}</span>${b ? `<span class="two">${esc(b)}</span>` : ""}</h1>`; };

const GAP = 100; // CSS px between the headline and the shot's edge; its shadow fades out within it
const css = `
  :root { --tile: #222126; --bg: #18171b; --accent: #B79CF0; --ink: #f4f2f7; --muted: #a39fae; --line: rgba(255,255,255,.10); }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body { background: radial-gradient(1300px 900px at 16% 30%, #2b2832 0%, var(--bg) 62%), var(--bg); color: var(--ink);
    font-family: Inter, "Liberation Sans", Arial, sans-serif; position: relative; -webkit-font-smoothing: antialiased; }
  .left { position: absolute; left: 112px; top: 100px; width: 760px; height: 1000px; display: flex; flex-direction: column; z-index: 2; }
  .slide.flip { background: radial-gradient(1300px 900px at 84% 30%, #2b2832 0%, var(--bg) 62%), var(--bg); }
  .brand { display: flex; align-items: center; gap: 22px; }
  .brand img { width: 76px; height: 76px; border-radius: 17px; box-shadow: 0 0 0 1px var(--line); }
  .brand .name { font-size: 40px; font-weight: 600; letter-spacing: -0.02em; }
  .brand .tag { font-size: 22px; font-weight: 600; color: #1d1a24; background: var(--accent); padding: 7px 16px; border-radius: 999px; }
  h1 { font-weight: 800; letter-spacing: -0.045em; line-height: 1.02; }
  h1 span { display: block; white-space: nowrap; width: max-content; }
  h1 .two { color: var(--accent); }
  .cover h1 { margin-top: 150px; font-size: 150px; }
  .slide h1 { margin-top: auto; font-size: 128px; }
  .sub { margin-top: 52px; font-size: 42px; line-height: 1.35; color: var(--muted); max-width: 740px; font-weight: 500; text-wrap: pretty; }
  .line { margin-top: 40px; margin-bottom: auto; font-size: 34px; line-height: 1.4; color: var(--muted); max-width: 660px; text-wrap: pretty; }
  .pills { margin-top: 52px; display: flex; flex-wrap: wrap; gap: 12px; }
  .pills span { font-size: 23px; font-weight: 500; padding: 11px 20px; border-radius: 999px; background: rgba(255,255,255,.05); box-shadow: inset 0 0 0 1.5px var(--line); }
  .pills span::before { content: ""; display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--accent); margin-right: 12px; vertical-align: 3px; }
  .foot { margin-top: auto; font-size: 19px; line-height: 1.5; color: #77727f; max-width: 640px; }
  .window { position: absolute; left: 930px; top: 150px; width: 1240px; border-radius: 16px; overflow: hidden; background: #fff;
    box-shadow: 0 0 0 1px rgba(255,255,255,.12), 0 40px 120px rgba(0,0,0,.55); }
  .window .bar { height: 44px; background: #ececef; display: flex; align-items: center; gap: 9px; padding-left: 18px; border-bottom: 1px solid #dcdce1; }
  .window .bar i { width: 13px; height: 13px; border-radius: 50%; display: block; }
  .window img { display: block; width: 1240px; }
  .phone { position: absolute; padding: 13px; border-radius: 62px; background: #0d0c0f; box-shadow: 0 0 0 2px #3a3840, 0 40px 100px rgba(0,0,0,.6); }
  .phone img { display: block; border-radius: 50px; }
  .shot { position: absolute; border-radius: 22px; overflow: hidden; background: #fff; box-shadow: 0 0 0 1px rgba(255,255,255,.14), 0 40px 120px rgba(0,0,0,.55); }
  .shot img { display: block; width: 100%; height: 100%; }
`;
const brand = `<div class="brand"><img src="${icon}" alt=""><span class="name">Follow-up</span><span class="tag">Paseo plugin</span></div>`;

function page(s) {
  if (s.kind === "cover") return `<body class="cover"><div class="left">${brand}${headline(s.headline)}<p class="sub">${esc(s.subline)}</p>
    <div class="pills">${s.pills.map(p => `<span>${esc(p)}</span>`).join("")}</div><p class="foot">${esc(footnote)}</p></div>
    <div class="window"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div><img src="${data(s.desktop)}" alt=""></div>
    <div class="phone" style="left:1480px;top:330px"><img src="${data(s.phone)}" alt="" style="width:372px"></div></body>`;
  // The element: as big as its box allows, never past its own pixels (the slide renders at 2×, so an image of w device
  // pixels shows crisp up to w/2 CSS pixels). Even-numbered slides mirror it: the box on the left, the text on the right.
  const flip = Number.parseInt(s.name) % 2 === 0;
  const { w, h } = size(s.src), right = s.phone ? { x: 1180, y: 70, w: 520, h: 1060 } : { x: 900, y: 90, w: 940, h: 1020 };
  const box = flip ? { ...right, x: W - right.x - right.w } : right;
  const k = Math.min(box.w / (w / 2), box.h / (h / 2), 1);
  const cw = Math.round(w / 2 * k), ch = Math.round(h / 2 * k);
  const left = box.x + Math.round((box.w - cw) / 2), top = box.y + Math.round((box.h - ch) / 2);
  const shot = s.phone
    ? `<div class="phone" style="left:${left - 13}px;top:${top - 13}px"><img src="${data(s.src)}" alt="" style="width:${cw}px;height:${ch}px"></div>`
    : `<div class="shot" style="left:${left}px;top:${top}px;width:${cw}px;height:${ch}px"><img src="${data(s.src)}" alt=""></div>`;
  // Mirrored, the text starts GAP clear of the element (or where the mirror of the left column would), and keeps the
  // left column's 112px margin on the right.
  const col = flip ? Math.max(W - 112 - 760, left + cw + GAP) : 0;
  const colStyle = flip ? ` style="left:${col}px;width:${W - 112 - col}px"` : "";
  return `<body class="slide${flip ? " flip" : ""}"><div class="left"${colStyle}>${brand}${headline(s.headline)}<p class="line">${esc(s.line)}</p></div>${shot}</body>`;
}

await harness();
const dir = mkdtempSync(join(tmpdir(), "follow-up-cover-"));
const exec = promisify(execFile);
try {
  const { chromium } = createRequire(join(process.env.PLAYWRIGHT_CORE, "package.json"))("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
  try {
    for (const s of SLIDES.filter(x => !onlyNames || onlyNames.some(n => x.name.endsWith(n)))) {
      writeFileSync(join(dir, "slide.html"), `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;800&display=block" rel="stylesheet"><style>${css}</style></head>${page(s)}</html>`);
      const p = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
      await p.goto(`file://${join(dir, "slide.html")}`);
      await p.evaluate(() => document.fonts.ready);
      await p.waitForFunction(() => [...document.images].every(i => i.complete));
      // Each headline line stays on one line, and clear of the shot and its shadow by at least GAP: the size steps down
      // until the wider line fits.
      const px = await p.evaluate(gap => {
        const h = document.querySelector("h1"), art = document.querySelector(".slide .shot, .slide .phone, .cover .window");
        const l = document.querySelector(".left").getBoundingClientRect(), a = art.getBoundingClientRect(), hl = h.getBoundingClientRect().left;
        const max = Math.min(760, a.left > l.left ? a.left - gap - hl : l.right - hl);
        let px = parseFloat(getComputedStyle(h).fontSize);
        while (px > 56 && Math.max(...[...h.children].map(c => c.getBoundingClientRect().width)) > max) h.style.fontSize = `${(px -= 2)}px`;
        return px;
      }, GAP);
      if (px <= 56) fail(`${s.name}: the headline is too long even at 56px; shorten it`);
      if (await p.evaluate(() => { const l = document.querySelector(".left"); return l.scrollHeight > l.clientHeight; })) fail(`${s.name}: the left column overflows`);
      const out = resolve(outDir, `follow-up-slide-${s.name}.png`);
      await p.screenshot({ path: out });
      await p.close();
      await exec("pngquant", ["--force", "--skip-if-larger", "--quality", "70-95", "--strip", "--output", out, out]).catch(() => {});
      console.log(`cover: ${out}`);
    }
  } finally { await browser.close(); }
} finally { rmSync(dir, { recursive: true, force: true }); }
