/**
 * a-clicked-row-holds-its-place (2026-11-24): a row the developer acted on leaves the list on the next read (a
 * reviewer request in flight drops the "Add reviewers" ask), and every row under it moved up, so the next click
 * landed on the row below the one aimed at. A list keeps an acted-on row where it was, showing its outcome, until
 * the list unmounts; only rows nobody touched come and go.
 *
 * `prev`: what the list drew last. `next`: what it would draw now. `held(key)`: whether a row has a local outcome to
 * keep showing. A held row missing from `next` goes back after the row that preceded it last time (or first).
 */
export function keepInPlace<T>(prev: readonly T[], next: readonly T[], keyOf: (row: T) => string, held: (key: string) => boolean): T[] {
  const out = [...next];
  const has = new Set(out.map(keyOf));
  for (const [i, row] of prev.entries()) {
    const key = keyOf(row);
    if (has.has(key) || !held(key)) continue;
    // After the nearest earlier row still drawn; none: at the top.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) { const k = out.findIndex(r => keyOf(r) === keyOf(prev[j])); if (k >= 0) { at = k + 1; break; } }
    out.splice(at, 0, row); has.add(key);
  }
  return out;
}
