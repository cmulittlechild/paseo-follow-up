import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SIDE_PANE_ALLOWED } from "../client/pane-allowlist";
import { paneBounds, sideWidth, toFraction } from "../shared/split";
import { displayPreferences, HOME_DETAIL_DEFAULT, HOME_DETAIL_MAX, HOME_DETAIL_MIN } from "../shared/display";

/**
 * side-panes-are-resizable (2026-11-16): Home's right pane (the brief, or the selected item) was `width: "42%"` capped
 * at 680 px, so on a wide window it couldn't grow and nothing let the developer drag the divider. Every desktop
 * layout that puts a pane beside a flexible one draws it through ResizableSplit (client/split.tsx), which keeps the
 * share in the Display settings; a fixed pane stays only in client/pane-allowlist.ts, with why it isn't one.
 */
const root = join(import.meta.dirname, "..");

async function clientFiles(): Promise<string[]> {
  const out = ["index.client.tsx"];
  for (const f of await readdir(join(root, "client"))) if (/\.tsx$/.test(f)) out.push(`client/${f}`);
  return out;
}

/**
 * The pane shapes a style object can take: a share of the row (`width: "42%"`) or a fixed px width of 240 or more,
 * clamped with a numeric minWidth/maxWidth of 200 or more (a side pane's signature; a 36% progress line or a 380 px
 * popover capped at 100% isn't one), or a flex ratio above 1 (`flex: 5` beside `flex: 6`). Absolutely positioned
 * views (menus, popovers) aren't panes.
 */
export function paneStyles(src: string): string[] {
  const hits: string[] = [];
  for (const m of src.matchAll(/style=\{\{([^{}]*)\}\}/g)) {
    const style = m[1];
    if (/position:\s*"absolute"/.test(style)) continue;
    const pct = /\bwidth:\s*"(\d{1,2})%"/.exec(style);
    const px = /(?<![A-Za-z])width:\s*(\d{3,})\b/.exec(style);
    const clamp = [...style.matchAll(/\b(?:minWidth|maxWidth):\s*(\d+)\b/g)].some(c => Number(c[1]) >= 200);
    // A share is a pane's (15–79%); 80% and up is a full-width element with side margins (a toast at 92%).
    if (pct && Number(pct[1]) >= 15 && Number(pct[1]) < 80 && clamp) hits.push(`width: "${pct[1]}%"`);
    else if (px && Number(px[1]) >= 240 && clamp) hits.push(`width: ${px[1]}`);
    const ratio = /(?<![A-Za-z])flex:\s*([2-9]\d*)\b/.exec(style);
    if (ratio) hits.push(`flex: ${ratio[1]}`);
  }
  return hits;
}

test("side-panes-are-resizable: no client layout puts a fixed pane beside a flexible one outside ResizableSplit", async () => {
  const offenders: string[] = [];
  for (const f of await clientFiles()) {
    if (f === "client/split.tsx") continue;
    for (const hit of paneStyles(await readFile(join(root, f), "utf8"))) if (!SIDE_PANE_ALLOWED[`${f}:${hit}`]) offenders.push(`${f}: ${hit}`);
  }
  assert.deepEqual(offenders, [], "draw the pane through ResizableSplit (client/split.tsx), or allowlist it in client/pane-allowlist.ts with a reason");
});

test("side-panes-are-resizable: every allowlisted layout is still there and says why", async () => {
  for (const [key, reason] of Object.entries(SIDE_PANE_ALLOWED)) {
    const [file, hit] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    assert.ok(paneStyles(await readFile(join(root, file), "utf8")).includes(hit), `${key} is gone: remove it from the allowlist`);
    assert.ok(reason.length >= 60, `${key}: the reason must say why it isn't a pane the developer should resize`);
  }
});

test("the guard matches pane shapes, not content caps, progress lines, popovers or menus", () => {
  assert.deepEqual(paneStyles(`<View style={{ width: "42%", minWidth: 380, maxWidth: 680 }}>`), [`width: "42%"`]);
  assert.deepEqual(paneStyles(`<View style={{ width: 320, minWidth: 280 }}>`), ["width: 320"]);
  assert.deepEqual(paneStyles(`<View style={{ flex: 5, minWidth: 0 }}>`), ["flex: 5"]);
  assert.deepEqual(paneStyles(`<View style={{ flex: 1, minWidth: 0 }}>`), []);
  assert.deepEqual(paneStyles(`<View style={{ width: "100%", maxWidth: 560 }}>`), []);
  assert.deepEqual(paneStyles(`<View style={{ width: "36%", minWidth: 6, height: 2 }}>`), []);
  assert.deepEqual(paneStyles(`<View style={{ width: 380, maxWidth: "100%", gap: 10 }}>`), []);
  assert.deepEqual(paneStyles(`<View style={{ width: "92%", maxWidth: 480, alignItems: "center" }}>`), []);
  assert.deepEqual(paneStyles(`<View style={{ position: "absolute", width: 256, minWidth: 256 }}>`), []);
});

test("Home draws its list and right pane through ResizableSplit, keyed to the Display setting", async () => {
  const src = await readFile(join(root, "client/home.tsx"), "utf8");
  assert.match(src, /<ResizableSplit\b/);
  assert.match(src, /home_detail_fraction/);
  assert.doesNotMatch(src, /width: "42%"/);
});

test("the pane's width is a clamped share of the split", () => {
  assert.equal(sideWidth(0.42, 1440, 360, 420), 605);
  assert.equal(sideWidth(0.1, 1440, 360, 420), 360, "never narrower than the pane's minimum");
  assert.equal(sideWidth(0.9, 1440, 360, 420), 1020, "the list keeps its minimum");
  assert.equal(sideWidth(0.5, 704, 360, 420), 325, "a split too narrow for both minimums shares the shortfall");
  assert.deepEqual(paneBounds(704, 360, 420), [325, 325]);
  assert.deepEqual(paneBounds(1120, 360, 420), [360, 700]);
  assert.equal(toFraction(605, 1440, [HOME_DETAIL_MIN, HOME_DETAIL_MAX]), 0.42);
  assert.equal(toFraction(1400, 1440, [HOME_DETAIL_MIN, HOME_DETAIL_MAX]), HOME_DETAIL_MAX);
  assert.equal(toFraction(10, 1440, [HOME_DETAIL_MIN, HOME_DETAIL_MAX]), HOME_DETAIL_MIN);
});

test("home_detail_fraction is a host Display field with the split's bounds", () => {
  const schema = displayPreferences.schema;
  assert.equal(schema.parse({}).home_detail_fraction, undefined, "absent means the default");
  assert.equal(schema.parse({ home_detail_fraction: 0.55 }).home_detail_fraction, 0.55);
  assert.equal(schema.safeParse({ home_detail_fraction: 0.95 }).success, false);
  assert.equal(schema.safeParse({ home_detail_fraction: 0.1 }).success, false);
  assert.ok(HOME_DETAIL_DEFAULT > HOME_DETAIL_MIN && HOME_DETAIL_DEFAULT < HOME_DETAIL_MAX);
});

test("the list's keyboard walk leaves a divider's keys to the divider (arrows, Home and End resize the pane)", async () => {
  const keys = await readFile(join(root, "client/list-keys.ts"), "utf8");
  assert.match(keys, /closest\?\.\('[^']*\[role="separator"\][^']*'\)\) return;/, "useListKeys skips a focused separator");
  const split = await readFile(join(root, "client/split.tsx"), "utf8");
  assert.match(split, /role: "separator"/);
  assert.match(split, /":focus-visible"/, "the focus ring shows for keyboard focus, never for a drag's mousedown");
});
