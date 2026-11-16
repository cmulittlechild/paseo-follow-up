/**
 * follow-up-has-one-mark (2026-11-16): every surface that stands for Follow-up itself draws FOLLOW_UP_ICON, a
 * self-contained currentColor glyph, and none falls back to lucide GitPullRequest (that icon means a pull request).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { findSvgIconProblem, PLUGIN_SVG_ICON_MAX_BYTES } from "@getpaseo/plugin";
import { FOLLOW_UP_DOT, FOLLOW_UP_ICON, NEED_DOT, needDotBox } from "../client/follow-up-icon";

test("the Follow-up glyph is valid inline SVG for the host, takes the host colour and is small", () => {
  const { svg } = FOLLOW_UP_ICON;
  assert.equal(findSvgIconProblem(svg), null);
  assert.ok(new TextEncoder().encode(svg).byteLength < PLUGIN_SVG_ICON_MAX_BYTES / 16, "well under the size cap");
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /fill="currentColor"/, "the end dot is filled with the host colour");
  assert.doesNotMatch(svg, /#[0-9a-f]{3,6}\b/i, "no fixed colour: the glyph follows the theme");
});

test("the app tile is the same mark", async () => {
  const tile = await readFile("assets/icon.svg", "utf8");
  const path = FOLLOW_UP_ICON.svg.match(/<path d="([^"]+)"/)?.[1];
  assert.ok(path && tile.includes(`d="${path}"`), "assets/icon.svg draws the glyph's path");
  const manifest = JSON.parse(await readFile("paseo-plugin.json", "utf8"));
  assert.equal(manifest.icon, "assets/icon.png");
});

test("Follow-up's own surfaces use the mark, never GitPullRequest", async () => {
  const entry = await readFile("index.client.tsx", "utf8");
  for (const call of [/addSettingsScreen\(\{ id: "projects"[^\n]*/, /addWorkspacePanel\(\{ id: PANEL[^\n]*/, /addCommandCenterItem\(\{ id: "open-follow-up",[^\n]*/]) {
    const line = entry.match(call)?.[0];
    assert.ok(line, String(call));
    assert.match(line, /icon: FOLLOW_UP_ICON/, line.slice(0, 60));
    assert.doesNotMatch(line, /GitPullRequest/);
  }
  const live = await readFile("client/live.tsx", "utf8");
  const header = live.slice(live.indexOf("export function headerIcon"), live.indexOf("export function sidebarItem"));
  assert.match(header, /<Icon icon=\{FOLLOW_UP_ICON\}/, "header button");
  assert.doesNotMatch(header, /GitPullRequest/);
  const sidebar = live.slice(live.indexOf("export function sidebarItem"));
  assert.match(sidebar, /<SidebarRow icon=\{FOLLOW_UP_ICON\}/, "sidebar row");
  assert.doesNotMatch(sidebar.slice(0, sidebar.indexOf("</>;")), /GitPullRequest/);
  const large = await readFile("client/large.tsx", "utf8");
  assert.match(large, /icon=\{FOLLOW_UP_ICON\} title="Nothing to show here"/, "the larger view's empty state");
});

test("the header's Needs-you dot stays whole inside the icon box, on the end dot as near as fits", () => {
  // Paseo clips a header button's icon to its box (overflow hidden); 2026-11-16 the centred dot drew flat-topped.
  for (const size of [14, 16, 20, 24]) {
    const { left, top } = needDotBox(size);
    assert.ok(left >= 0 && top >= 0 && left + NEED_DOT <= size && top + NEED_DOT <= size, `inside at ${size}`);
    const dx = left + NEED_DOT / 2 - size * FOLLOW_UP_DOT.x, dy = top + NEED_DOT / 2 - size * FOLLOW_UP_DOT.y;
    assert.ok(Math.hypot(dx, dy) < 1, `within 1 px of the end dot at ${size}`);
  }
  const live = readFileSync("client/live.tsx", "utf8");
  assert.match(live, /\.\.\.needDotBox\(props\.size\)/, "the header icon places its dot with needDotBox");
});
