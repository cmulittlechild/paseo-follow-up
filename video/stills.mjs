// Renders single frames of the edit for review: node stills.mjs <seconds...> (writes out/stills/).
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import * as fs from "node:fs/promises";
import { resolve, join } from "node:path";
const take = JSON.parse(await fs.readFile("public/take/take.json", "utf8"));
const serveUrl = await bundle({ entryPoint: resolve("src/index.ts"), publicDir: resolve("public") });
const inputProps = { take };
const composition = await selectComposition({ serveUrl, id: "FollowUpDemo", inputProps, browserExecutable: process.env.CHROMIUM ?? null });
await fs.mkdir("out/stills", { recursive: true });
for (const s of process.argv.slice(2)) {
  const frame = Math.min(composition.durationInFrames - 1, Math.round(Number(s) * composition.fps));
  await renderStill({ serveUrl, composition, inputProps, frame, output: join("out/stills", `t${s}.png`), browserExecutable: process.env.CHROMIUM ?? null, chromiumOptions: { gl: "swangle" } });
  console.log("still", s);
}
