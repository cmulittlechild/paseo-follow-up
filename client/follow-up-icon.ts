import type { PluginSvgIcon } from "@getpaseo/plugin/client";

/**
 * Follow-up's own mark: a loop that runs on from a start ring to a filled dot (the work, followed until it's done).
 * One 24-unit glyph in `currentColor`, so the host `Icon` colours it with the theme. It is the brand icon on every
 * surface that stands for Follow-up itself (sidebar row, header button, panel tab, Settings, the open command, the
 * large view's empty state). Pull requests keep lucide GitPullRequest. assets/icon.svg is the same mark on the app tile.
 * tests/follow-up-icon.test.ts checks it with the SDK's validator and that no brand surface falls back to GitPullRequest.
 */
export const FOLLOW_UP_ICON: PluginSvgIcon = {
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.2 19C11 19 15.6 17.8 15.6 13.6C15.6 10.9 13.6 9.6 11.9 9.6C10.2 9.6 8.6 10.9 8.6 12.9C8.6 15.3 11 16.2 13 15.1C15.2 13.9 15.9 10.5 16.6 7.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="4.6" cy="19" r="2.3" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="17.4" cy="4.9" r="2.9" fill="currentColor"/></svg>`,
};

/** Where the end dot sits, as a fraction of the icon box: the header button's Needs-you badge covers it. */
export const FOLLOW_UP_DOT = { x: 17.4 / 24, y: 4.9 / 24 };

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
