import { useMemo } from "react";
import { AbsoluteFill, Freeze, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, Easing, interpolate, spring } from "remotion";
import "@fontsource/inter/latin-600.css";

const fontFamily = "Inter";

export type Box = { x: number; y: number; width: number; height: number };
export type Take = {
  fps: number; seconds: number; view: { width: number; height: number }; scale: number;
  beats: Record<string, number>;
  pointer: [number, number, number][]; presses: [number, number, number][];
  focus: { t: number; name: string; box: Box | null; zoom: number | null }[];
  typing: [number, number][];
};

// ---------- the stage ----------
// 1920×1200. The app floats as a window on a dark, slowly moving field; the camera moves the whole stage, the caption
// stays put in screen space under it.
const W = 1920, H = 1200;
const WIN = { x: 160, y: 56, w: 1600, h: 1000 };
/** Zoomed in, the subject is framed this many px above the frame's centre, clear of the caption under it. */
const SAFE = 80;
const INK = "#F4F2F7", LILAC = "#B79CF0", FIELD = "#141318";

const CAPTIONS: { beat: string; words: string; accent: string }[] = [
  { beat: "home", words: "Every agent, one inbox.", accent: "one inbox." },
  { beat: "catchup", words: "Answer in seconds.", accent: "seconds." },
  { beat: "repairs", words: "Fixes go back by themselves.", accent: "by themselves." },
  { beat: "overseer", words: "Ask across every workspace.", accent: "every workspace." },
  { beat: "end", words: "Every agent, one inbox.", accent: "one inbox." },
];

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const toStage = (take: Take, x: number, y: number) => [WIN.x + (x / take.view.width) * WIN.w, WIN.y + (y / take.view.height) * WIN.h] as const;

function pointerAt(take: Take, t: number): [number, number] {
  const p = take.pointer;
  if (!p.length) return [take.view.width * 0.86, take.view.height * 0.9];
  if (t <= p[0][0]) return [p[0][1], p[0][2]];
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p[mid][0] <= t) lo = mid; else hi = mid; }
  const [ta, xa, ya] = p[lo], [tb, xb, yb] = p[hi];
  if (t >= tb) return [xb, yb];
  const k = tb > ta ? (t - ta) / (tb - ta) : 1;
  return [xa + (xb - xa) * k, ya + (yb - ya) * k];
}

// ---------- the camera: springs toward what the take says to look at ----------
type Cam = { s: number; x: number; y: number };
/** Zoom per focus name where the take's own choice frames too tight (Catch up's card box is its body, not its title). */
const ZOOM: Record<string, number> = { card: 1.2 };
/**
 * One camera state per frame, simulated forward once: a critically damped spring (no overshoot, ~0.8 s to settle)
 * on log-zoom and centre, chasing the latest focus box (logged before the pointer moves, so the camera anticipates).
 */
function cameraTrack(take: Take, frames: number, fps: number): Cam[] {
  const LEAD = 0.1, OMEGA = 2 * Math.PI * 0.75;
  const target = (t: number): Cam => {
    let f: Take["focus"][number] | undefined;
    for (const e of take.focus) if (e.t <= t + LEAD) f = e;
    if (!f || !f.box) return { s: 1, x: W / 2, y: H / 2 };
    const [x0, y0] = toStage(take, f.box.x, f.box.y), [x1, y1] = toStage(take, f.box.x + f.box.width, f.box.y + f.box.height);
    const fit = Math.min((W * 0.78) / Math.max(1, x1 - x0), (H * 0.7) / Math.max(1, y1 - y0));
    const s = clamp(ZOOM[f.name] ?? f.zoom ?? fit, 1, 1.7);
    return { s, x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  };
  const out: Cam[] = [];
  let cur = target(0), v = { s: 0, x: 0, y: 0 };
  let ls = Math.log(cur.s);
  const dt = 1 / fps / 4;
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < 4; k++) {
      const g = target((f + k / 4) / fps), lg = Math.log(g.s);
      v.s += (OMEGA * OMEGA * (lg - ls) - 2 * OMEGA * v.s) * dt; ls += v.s * dt;
      v.x += (OMEGA * OMEGA * (g.x - cur.x) - 2 * OMEGA * v.x) * dt; cur.x += v.x * dt;
      v.y += (OMEGA * OMEGA * (g.y - cur.y) - 2 * OMEGA * v.y) * dt; cur.y += v.y * dt;
    }
    const s = Math.exp(ls);
    // Keep the frame on the window (plus a margin of the field) once zoomed in.
    const vw = W / s, vh = H / s, m = 48;
    const bx0 = Math.max(0, WIN.x - m), bx1 = Math.min(W, WIN.x + WIN.w + m), by0 = Math.max(0, WIN.y - m), by1 = Math.min(H, WIN.y + WIN.h + m + 60);
    const x = vw >= bx1 - bx0 ? W / 2 : clamp(cur.x, bx0 + vw / 2, bx1 - vw / 2);
    const y = vh >= by1 - by0 ? H / 2 : clamp(cur.y, by0 + vh / 2, by1 - vh / 2);
    out.push({ s, x: s <= 1.0005 ? W / 2 : x, y: s <= 1.0005 ? H / 2 : y });
  }
  return out;
}

// ---------- pieces ----------
const Field = ({ t }: { t: number }) => {
  const ax = 22 + Math.sin(t * 0.35) * 6, ay = 18 + Math.cos(t * 0.28) * 5;
  const bx = 80 + Math.cos(t * 0.31) * 7, by = 88 + Math.sin(t * 0.24) * 5;
  return (
    <AbsoluteFill style={{
      background: `radial-gradient(60% 55% at ${ax}% ${ay}%, rgba(183,156,240,0.20), rgba(183,156,240,0) 70%),
        radial-gradient(55% 50% at ${bx}% ${by}%, rgba(120,140,255,0.13), rgba(120,140,255,0) 70%), ${FIELD}`,
    }} />
  );
};

const Arrow = () => (
  <svg width="30" height="36" viewBox="0 0 22 26" style={{ display: "block", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))" }}>
    <path d="M3 2.2 L3 20.4 L7.7 15.9 L10.7 22.9 L13.6 21.7 L10.6 14.8 L17.2 14.4 Z" fill="#fff" stroke="#222126" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);

/** The pointer: the take's own path, a dip and a lilac ring on each press. */
const Pointer = ({ take, t, fps }: { take: Take; t: number; fps: number }) => {
  const at = (u: number) => toStage(take, ...pointerAt(take, u));
  const [x, y] = at(t);
  let press = 1;
  const rings: { x: number; y: number; k: number }[] = [];
  for (const [pt, cx, cy] of take.presses) {
    const d = t - pt;
    if (d > -0.12 && d < 0.2) press = Math.min(press, 1 - 0.16 * Math.sin(clamp((d + 0.12) / 0.32, 0, 1) * Math.PI));
    if (d >= 0 && d < 0.65) { const [sx, sy] = toStage(take, cx, cy); rings.push({ x: sx, y: sy, k: d / 0.65 }); }
  }
  return (
    <>
      {rings.map((r, i) => {
        const e = Easing.out(Easing.cubic)(r.k), size = 18 + e * 70;
        return <div key={i} style={{ position: "absolute", left: r.x - size / 2, top: r.y - size / 2, width: size, height: size, borderRadius: "50%",
          border: `3px solid ${LILAC}`, background: "rgba(183,156,240,0.18)", opacity: 1 - e }} />;
      })}
      <div style={{ position: "absolute", left: x - 4, top: y - 3, transform: `scale(${press})`, transformOrigin: "4px 3px" }}><Arrow /></div>
    </>
  );
};

const Mark = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" style={{ display: "block" }}>
    <rect width="256" height="256" rx="58" fill="#222126" stroke="rgba(255,255,255,0.14)" strokeWidth="4" />
    <g transform="translate(24.8 24.8) scale(8.6)">
      <path d="M6.95 19.21C7.25 19.11 8.19 18.91 8.75 18.59C9.3 18.27 9.7 18 10.29 17.29C10.89 16.58 11.8 15.23 12.34 14.32C12.87 13.41 13.14 12.75 13.51 11.84C13.88 10.93 14.29 9.96 14.57 8.87C14.84 7.78 15.17 6.23 15.18 5.28C15.2 4.33 14.88 3.61 14.63 3.18C14.38 2.74 14.04 2.66 13.7 2.68C13.36 2.7 12.92 2.85 12.58 3.3C12.25 3.75 11.93 4.48 11.72 5.4C11.5 6.33 11.32 7.8 11.29 8.87C11.25 9.94 11.36 10.93 11.53 11.84C11.71 12.75 11.97 13.58 12.34 14.32C12.71 15.06 13.23 15.8 13.76 16.3C14.29 16.79 14.98 17.03 15.49 17.29C16.01 17.55 16.63 17.75 16.86 17.85" fill="none" stroke="#fff" strokeWidth="1.42" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="4.85" cy="19.15" r="2.14" fill="none" stroke="#fff" strokeWidth="1.42" />
      <circle cx="20.01" cy="18.03" r="1.92" fill={LILAC} />
    </g>
  </svg>
);

/**
 * The caption: words rise in out of a blur one after another, the accent words in lilac with a line that sweeps under
 * them, then leave upward the same way just before the next beat. The first and last caption are the same, held
 * still at the cut, so the loop has no seam.
 */
const Caption = ({ take, t, zoom, fps }: { take: Take; t: number; zoom: number; fps: number }) => {
  const starts = CAPTIONS.map((c, i) => (i === 0 ? -100 : take.beats[c.beat] ?? Infinity));
  let i = 0;
  for (let k = 0; k < CAPTIONS.length; k++) if (t >= starts[k] - 0.05) i = k;
  const cap = CAPTIONS[i], start = starts[i], end = i + 1 < CAPTIONS.length ? starts[i + 1] : Infinity;
  const words = cap.words.split(" ");
  const accentFrom = words.length - cap.accent.split(" ").length;
  const inE = Easing.bezier(0.16, 1, 0.3, 1), outE = Easing.bezier(0.7, 0, 0.84, 0);
  const sweep = i === 0 ? 1 : inE(clamp((t - start - 0.35 - accentFrom * 0.06) / 0.6, 0, 1));
  const leave = inE(clamp((t - (end - 0.34)) / 0.3, 0, 1));
  const word = (w: string, j: number, color: string) => {
    const enter = i === 0 ? 1 : inE(clamp((t - start - j * 0.06) / 0.55, 0, 1));
    const exit = outE(clamp((t - (end - 0.36) - j * 0.035) / 0.3, 0, 1));
    return (
      <span key={`${i}-${j}`} style={{ display: "inline-block", color, opacity: enter * (1 - exit),
        transform: `translateY(${(1 - enter) * 28 - exit * 18}px)`, filter: `blur(${(1 - enter) * 10 + exit * 8}px)` }}>{w}</span>
    );
  };
  const pop = i === 0 ? 1 : 0.82 + 0.18 * spring({ frame: Math.max(0, (t - start) * fps), fps, config: { damping: 10, stiffness: 170 } });
  // A scrim rises behind the caption while the camera is in, so it reads over the app.
  const scrim = clamp((zoom - 1) / 0.18, 0, 1);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 300, opacity: scrim,
        background: "linear-gradient(to top, rgba(14,13,18,0.92) 0%, rgba(14,13,18,0.75) 40%, rgba(14,13,18,0) 100%)" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 34, height: 92, display: "flex", alignItems: "center", justifyContent: "center", gap: 26 }}>
        <div style={{ transform: `scale(${pop}) rotate(${(1 - pop) * -40}deg)` }}><Mark size={66} /></div>
        <div style={{ fontFamily, fontSize: 56, fontWeight: 600, letterSpacing: "-0.028em", color: INK, whiteSpace: "nowrap", display: "flex", gap: "0.26em" }}>
          {words.slice(0, accentFrom).map((w, j) => word(w, j, INK))}
          <span style={{ display: "inline-flex", gap: "0.26em", position: "relative" }}>
            {words.slice(accentFrom).map((w, j) => word(w, accentFrom + j, LILAC))}
            <span style={{ position: "absolute", left: 0, right: "0.32em", bottom: -6, height: 4, borderRadius: 2, background: LILAC,
              opacity: 0.75 * (1 - leave), transformOrigin: "left", transform: `scaleX(${sweep})` }} />
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------- the edit ----------
export const Demo = ({ take }: { take: Take | null }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const cams = useMemo(() => (take ? cameraTrack(take, durationInFrames, fps) : []), [take, durationInFrames, fps]);
  if (!take) return null;
  const t = frame / fps;
  const cam = cams[Math.min(frame, cams.length - 1)];
  // The last half second dissolves into the first frame of the app, so the loop's cut is invisible.
  const loopFade = interpolate(frame, [durationInFrames - 16, durationInFrames - 1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  const shadow = interpolate(cam.s, [1, 1.5], [1, 0.4], { extrapolateRight: "clamp" });
  const video = { position: "absolute" as const, inset: 0, width: WIN.w, height: WIN.h };
  return (
    <AbsoluteFill style={{ background: FIELD, overflow: "hidden" }}>
      <AbsoluteFill style={{ transformOrigin: "0 0", transform: `translate(${W / 2}px, ${H / 2 - SAFE * clamp((cam.s - 1) / 0.18, 0, 1)}px) scale(${cam.s}) translate(${-cam.x}px, ${-cam.y}px)` }}>
        <Field t={t} />
        <div style={{ position: "absolute", left: WIN.x, top: WIN.y, width: WIN.w, height: WIN.h, borderRadius: 18, overflow: "hidden",
          boxShadow: `0 ${40 * shadow}px ${120 * shadow}px rgba(0,0,0,${0.55 * shadow}), 0 0 0 1px rgba(255,255,255,0.09)`, background: "#fff" }}>
          <OffthreadVideo src={staticFile("take/raw.mp4")} style={video} muted />
          {loopFade > 0 && (
            <Freeze frame={0}><div style={{ ...video, opacity: loopFade }}><OffthreadVideo src={staticFile("take/raw.mp4")} style={video} muted /></div></Freeze>
          )}
        </div>
        <Pointer take={take} t={t} fps={fps} />
      </AbsoluteFill>
      <Caption take={take} t={t} zoom={cam.s} fps={fps} />
    </AbsoluteFill>
  );
};
