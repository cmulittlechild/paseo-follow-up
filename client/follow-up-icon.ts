import type { PluginSvgIcon } from "@getpaseo/plugin/client";

/**
 * Follow-up's own mark: a cursive l that runs on from a start ring to a filled dot (the work, followed until it's done).
 * One 24-unit glyph in `currentColor`, so the host `Icon` colours it with the theme. It is the brand icon on every
 * surface that stands for Follow-up itself (sidebar row, header button, panel tab, Settings, the open command, the
 * large view's empty state). Pull requests keep lucide GitPullRequest. assets/icon.svg is the same mark on the app tile.
 * tests/follow-up-icon.test.ts checks it with the SDK's validator and that no brand surface falls back to GitPullRequest.
 */
export const FOLLOW_UP_ICON: PluginSvgIcon = {
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6.95 19.21C7.25 19.11 8.19 18.91 8.75 18.59C9.3 18.27 9.7 18 10.29 17.29C10.89 16.58 11.8 15.23 12.34 14.32C12.87 13.41 13.14 12.75 13.51 11.84C13.88 10.93 14.29 9.96 14.57 8.87C14.84 7.78 15.17 6.23 15.18 5.28C15.2 4.33 14.88 3.61 14.63 3.18C14.38 2.74 14.04 2.66 13.7 2.68C13.36 2.7 12.92 2.85 12.58 3.3C12.25 3.75 11.93 4.48 11.72 5.4C11.5 6.33 11.32 7.8 11.29 8.87C11.25 9.94 11.36 10.93 11.53 11.84C11.71 12.75 11.97 13.58 12.34 14.32C12.71 15.06 13.23 15.8 13.76 16.3C14.29 16.79 14.98 17.03 15.49 17.29C16.01 17.55 16.63 17.75 16.86 17.85" fill="none" stroke="currentColor" stroke-width="1.42" stroke-linecap="round" stroke-linejoin="round"/><circle cx="4.85" cy="19.15" r="2.14" fill="none" stroke="currentColor" stroke-width="1.42"/><circle cx="20.01" cy="18.03" r="1.92" fill="currentColor"/></svg>`,
};

/** Where the end dot sits, as a fraction of the icon box: the header button's Needs-you badge covers it. */
export const FOLLOW_UP_DOT = { x: 20.01 / 24, y: 18.03 / 24 };

/** The header button's Needs-you dot, in px. */
export const NEED_DOT = 7;

/**
 * Where the Needs-you dot goes in a `size` icon box: centred on the end dot, clamped inside the box. Paseo draws a
 * header button's icon in a box of exactly that size with `overflow: hidden` (`ButtonIcon`, 16 px on 0.15 and 0.16),
 * so any part outside it is cut off: centred at 16 px the dot's top sat 0.23 px above the box and drew flat-topped.
 */
export function needDotBox(size: number): { left: number; top: number } {
  const clamp = (v: number) => Math.min(Math.max(v, 0), Math.max(size - NEED_DOT, 0));
  return { left: clamp(size * FOLLOW_UP_DOT.x - NEED_DOT / 2), top: clamp(size * FOLLOW_UP_DOT.y - NEED_DOT / 2) };
}
