// Preloaded (node --require) by scripts/scale-check.mjs --retain-mb <n>: a synthetic regression for proving the scale
// gate still catches growth. A plugin process holds SCALE_RETAIN_MB MB for its whole life, half on V8's heap and half
// native (touched Buffers), the two places a real leak lands. Other processes (the daemon, agents) are left alone.
const mb = Number(process.env.SCALE_RETAIN_MB || 0);
if (mb > 0 && process.argv.some(a => /plugin-process/.test(a))) {
  const held = (globalThis.__scaleRetained = []);
  const half = Math.round(mb / 2);
  for (let i = 0; i < half; i++) held.push(Buffer.alloc(1024 * 1024, 1));
  for (let i = 0; i < mb - half; i++) held.push(new Array(1024 * 1024 / 8).fill(i + 0.5));
}
