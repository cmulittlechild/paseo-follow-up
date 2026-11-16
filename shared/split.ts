/** Pure geometry for ResizableSplit (client/split.tsx), kept here so tests run without React Native. */

/**
 * The side pane's narrowest and widest width in px for a split `total` wide: at least `minSide`, leaving the main side
 * at least `minMain`. A split too narrow for both minimums shares the shortfall in proportion to them, so neither side
 * collapses to make room for the other (and the divider has nowhere to go).
 */
export function paneBounds(total: number, minSide: number, minMain: number): [number, number] {
  if (total >= minSide + minMain) return [minSide, total - minMain];
  const fit = Math.round(total * minSide / (minSide + minMain));
  return [fit, fit];
}

/** The side pane's width in px for a fraction of `total`, inside paneBounds. */
export function sideWidth(fraction: number, total: number, minSide: number, minMain: number): number {
  const [lo, hi] = paneBounds(total, minSide, minMain);
  return Math.round(Math.min(hi, Math.max(lo, fraction * total)));
}

/** The fraction a side width is of `total`, kept inside the setting's range and rounded to 0.001. */
export function toFraction(width: number, total: number, [lo, hi]: [number, number]): number {
  if (!total) return lo;
  return Math.round(Math.min(hi, Math.max(lo, width / total)) * 1000) / 1000;
}
