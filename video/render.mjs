// Renders Follow-up's demo video v2 from the take scripts/demo-video-v2.mjs wrote to public/take/.
// Usage (from video/, through harness-slot): node render.mjs [--out <dir>] [--concurrency <n>]
// Writes follow-up-demo-v2.mp4 (H.264 1920×1200, faststart), follow-up-demo-v2-poster.png (frame 0, which is also the
// loop's last frame), follow-up-demo-v2.webp (800×500, 8 fps animated fallback), frames/ (one PNG a second, to review) and
// contact-sheet.png (those frames tiled in time order, 1 s apart, left to right).
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const out = resolve(arg("--out", "out"));
const FFMPEG = createRequire(import.meta.url)("ffmpeg-static");
const take = JSON.parse(await fs.readFile("public/take/take.json", "utf8"));
await fs.mkdir(out, { recursive: true });

const serveUrl = await bundle({ entryPoint: resolve("src/index.ts"), publicDir: resolve("public") });
const inputProps = { take };
const composition = await selectComposition({ serveUrl, id: "FollowUpDemo", inputProps, browserExecutable: process.env.CHROMIUM ?? null });
const mp4 = join(out, "follow-up-demo-v2.mp4");
const t0 = Date.now();
let shown = -1;
await renderMedia({
  serveUrl, composition, inputProps, codec: "h264", crf: 18, pixelFormat: "yuv420p", x264Preset: "slow",
  outputLocation: mp4, concurrency: Number(arg("--concurrency", "3")), browserExecutable: process.env.CHROMIUM ?? null,
  chromiumOptions: { gl: "swangle" }, muted: true, enforceAudioTrack: false,
  onProgress: ({ progress }) => { const p = Math.floor(progress * 10) * 10; if (p !== shown) { shown = p; console.log(`[render] ${p}%`); } },
});
console.log(`\n[render] ${mp4} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
// Remotion's master is near-lossless; the shipped file is re-encoded for the web: TV-range yuv420p (Remotion writes
// full-range yuvj420p, which some players show washed out), at CRF 21 so small UI text stays sharp in the wide shots.
await exec(FFMPEG, ["-nostdin", "-v", "error", "-y", "-i", mp4, "-c:v", "libx264", "-preset", "veryslow", "-crf", "21", "-tune", "animation",
  "-vf", "scale=in_range=full:out_range=tv,format=yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
  "-movflags", "+faststart", "-an", join(out, "fs.mp4")], { maxBuffer: 1 << 24 });
await fs.rename(join(out, "fs.mp4"), mp4);
const ff = (...a) => exec(FFMPEG, ["-nostdin", "-v", "error", "-y", ...a], { maxBuffer: 1 << 24 });
await ff("-i", mp4, "-frames:v", "1", join(out, "follow-up-demo-v2-poster.png"));
await ff("-i", mp4, "-vf", "fps=8,scale=800:500:flags=lanczos", "-c:v", "libwebp_anim", "-lossless", "0", "-q:v", "45", "-compression_level", "3", "-loop", "0", join(out, "follow-up-demo-v2.webp"));
const frames = join(out, "frames");
await fs.rm(frames, { recursive: true, force: true }); await fs.mkdir(frames);
await ff("-i", mp4, "-vf", "fps=1:start_time=0,select='1'", "-fps_mode", "vfr", join(frames, "s%02d.png"));
const n = (await fs.readdir(frames)).length, cols = 6, rows = Math.ceil(n / cols);
await ff("-pattern_type", "glob", "-i", join(frames, "s*.png"), "-vf", `scale=480:300,tile=${cols}x${rows}:padding=6:margin=6:color=0x141318`, "-frames:v", "1", join(out, "contact-sheet.png"));
const size = async p => `${((await fs.stat(p)).size / 1048576).toFixed(2)} MB`;
console.log(`[render] mp4 ${await size(mp4)}, webp ${await size(join(out, "follow-up-demo-v2.webp"))}, ${n} review frames, contact sheet`);
