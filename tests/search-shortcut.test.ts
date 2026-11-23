import { normalizeCombos } from "../shared/paseo-keys";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SEARCH_SHORTCUT, isMac, matchesShortcut, PASEO_BOUND, SEARCH_SHORTCUTS, searchShortcutOf, searchShortcutOptions, shortcutCombos, shortcutLabel, type KeyEventLike, type SearchShortcut } from "../shared/search-key";
import { displayPreferences } from "../shared/display";

/**
 * every-shortcut-is-configurable-and-never-paseo-s (2026-11-16): one key opens Follow-up Home with the cursor in its
 * search from anywhere in Paseo. It's a Display setting with None, matched with exact modifiers, and no preset is a
 * combo Paseo's web app binds.
 */
const root = join(import.meta.dirname, "..");
const key = (over: Partial<KeyEventLike>): KeyEventLike => ({ key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
const mod = (mac: boolean) => (mac ? { metaKey: true } : { ctrlKey: true });
const PRESS: Record<Exclude<SearchShortcut, "none">, Partial<KeyEventLike>> = {
  "mod-shift-k": { key: "K", code: "KeyK", shiftKey: true },
  "mod-shift-h": { key: "H", code: "KeyH", shiftKey: true },
};

for (const mac of [true, false]) {
  const os = mac ? "Mac" : "Windows and Linux";
  test(`${os}: each preset matches its own chord and no other preset's`, () => {
    for (const [preset, press] of Object.entries(PRESS)) {
      for (const other of SEARCH_SHORTCUTS) {
        assert.equal(matchesShortcut(key({ ...press, ...mod(mac) }), other, mac), other === preset, `${preset} pressed, ${other} set`);
      }
    }
  });
  test(`${os}: the other platform's modifier, extra modifiers, a missing Shift, composing and repeat never match`, () => {
    for (const [preset, press] of Object.entries(PRESS) as [SearchShortcut, Partial<KeyEventLike>][]) {
      assert.equal(matchesShortcut(key({ ...press, ...(mac ? { ctrlKey: true } : { metaKey: true }) }), preset, mac), false, `${preset}: wrong modifier`);
      assert.equal(matchesShortcut(key({ ...press }), preset, mac), false, `${preset}: no modifier`);
      assert.equal(matchesShortcut(key({ ...press, ...mod(mac), altKey: true }), preset, mac), false, `${preset}: with Alt`);
      assert.equal(matchesShortcut(key({ ...press, metaKey: true, ctrlKey: true }), preset, mac), false, `${preset}: with both ⌘ and Ctrl`);
      assert.equal(matchesShortcut(key({ ...press, ...mod(mac), shiftKey: !press.shiftKey }), preset, mac), false, `${preset}: Shift flipped`);
      assert.equal(matchesShortcut(key({ ...press, ...mod(mac), isComposing: true }), preset, mac), false, `${preset}: composing`);
      assert.equal(matchesShortcut(key({ ...press, ...mod(mac), repeat: true }), preset, mac), false, `${preset}: auto-repeat`);
    }
  });
  test(`${os}: None matches nothing`, () => {
    for (const press of Object.values(PRESS)) assert.equal(matchesShortcut(key({ ...press, ...mod(mac) }), "none", mac), false);
  });
}

test("the physical key matches on another keyboard layout", () => {
  assert.equal(matchesShortcut(key({ key: "л", code: "KeyK", metaKey: true, shiftKey: true }), "mod-shift-k", true), true);
});

test("labels print the way each platform does, and None has none", () => {
  assert.equal(shortcutLabel("mod-shift-k", true), "⌘⇧K");
  assert.equal(shortcutLabel("mod-shift-k", false), "Ctrl+Shift+K");
  assert.equal(shortcutLabel("mod-shift-h", false), "Ctrl+Shift+H");
  assert.equal(shortcutLabel("none", true), null);
  assert.deepEqual(searchShortcutOptions(true).map(o => o.label), ["⌘⇧K", "⌘⇧H", "None"]);
  assert.equal(isMac("MacIntel"), true);
  assert.equal(isMac("Linux x86_64"), false);
});

test("every-shortcut-is-configurable-and-never-paseo-s: no preset takes a combo Paseo binds", () => {
  const bound = new Set(normalizeCombos(PASEO_BOUND));
  for (const preset of SEARCH_SHORTCUTS) for (const combo of shortcutCombos(preset)) assert.ok(!bound.has(combo), `${preset} (${combo}) is one of Paseo's own keys`);
  // The pinned list is the real one: ⌘K is Paseo's command center, ? its shortcut list.
  assert.ok(bound.has("Cmd+K") && bound.has("Ctrl+K") && bound.has("Shift+?"));
  // A preset spelled like one of Paseo's is caught.
  assert.deepEqual(shortcutCombos("mod-shift-k"), ["Cmd+Shift+K", "Ctrl+Shift+K"]);
});

test("search_shortcut is a host Display field: absent or unknown reads as the default, never as off", () => {
  assert.equal(displayPreferences.schema.parse({}).search_shortcut, undefined);
  assert.equal(searchShortcutOf(undefined), DEFAULT_SEARCH_SHORTCUT);
  assert.equal(searchShortcutOf("mod-shift-q"), DEFAULT_SEARCH_SHORTCUT);
  assert.equal(displayPreferences.schema.safeParse({ search_shortcut: "mod-shift-q" }).success, false);
  assert.equal(displayPreferences.schema.parse({ search_shortcut: "none" }).search_shortcut, "none");
});

test("one global listener, web only, in the capture phase; the ⌘K row and Home's chip name the key", async () => {
  const src = await readFile(join(root, "client/search-key.ts"), "utf8");
  assert.match(src, /Platform\.OS !== "web"/);
  assert.match(src, /addEventListener\("keydown", onKey, true\)/);
  assert.match(src, /e\.preventDefault\(\)/);
  assert.match(src, /closest\?\.\(EDITOR_SELECTOR\)/, "a code editor keeps its own Mod-/ (Paseo 0.16's CodeMirror toggles comments)");
  const entry = await readFile(join(root, "index.client.tsx"), "utf8");
  assert.equal(entry.match(/installSearchShortcut\(/g)?.length, 1, "installed once");
  assert.match(entry, /`Follow-up: Search \(\$\{label\}\)`/);
  const home = await readFile(join(root, "client/home.tsx"), "utf8");
  assert.match(home, /anywhereKey=\{anywhereKey\}/);
});

// New from anywhere (`new_shortcut`, docs/dispatch.md#the-dialog): the default depends on the host, a pick wins.
import { NEW_SHORTCUTS, isDesktopApp, newShortcutHint, newShortcutOptions, newShortcutPreset } from "../shared/search-key";

test("New from anywhere: ⌘⇧N in Paseo's desktop app, ⌘⇧O in a browser tab, and a pick wins on both", () => {
  assert.equal(newShortcutPreset(undefined, true), "mod-shift-n");
  assert.equal(newShortcutPreset(undefined, false), "mod-shift-o", "Chrome keeps Ctrl/Cmd+Shift+N for incognito in a tab");
  assert.equal(newShortcutPreset("garbage", false), "mod-shift-o");
  for (const desktop of [true, false]) for (const pick of NEW_SHORTCUTS) assert.equal(newShortcutPreset(pick, desktop), pick);
  assert.equal(isDesktopApp({ paseoDesktop: {} }), true);
  assert.equal(isDesktopApp({ navigator: { userAgent: "Mozilla/5.0 Chrome/140 Electron/38.0.0" } }), true);
  assert.equal(isDesktopApp({ navigator: { userAgent: "Mozilla/5.0 Chrome/140 Safari/537.36" } }), false);
  assert.deepEqual(newShortcutOptions(true).map(o => o.label), ["⌘⇧N", "⌘⇧O", "None"]);
  assert.deepEqual(newShortcutOptions(false).map(o => o.label), ["Ctrl+Shift+N", "Ctrl+Shift+O", "None"]);
  assert.match(newShortcutHint(false, true), /⌘⇧N for a new incognito window, so ⌘⇧O/);
  const press = (key: string, mod: Partial<KeyEventLike> = {}): KeyEventLike => ({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, ...mod });
  assert.equal(matchesShortcut(press("N"), "mod-shift-n", true), true);
  assert.equal(matchesShortcut(press("o"), "mod-shift-o", true), true);
  assert.equal(matchesShortcut(press("n"), "mod-shift-o", true), false);
  assert.equal(matchesShortcut(press("n", { shiftKey: false }), "mod-shift-n", true), false, "⌘N stays Paseo's");
  assert.equal(matchesShortcut(press("n"), "none", true), false);
});

test("New from anywhere never takes one of Paseo's own keys", () => {
  const bound = new Set(normalizeCombos(PASEO_BOUND));
  for (const preset of NEW_SHORTCUTS) for (const combo of shortcutCombos(preset)) assert.ok(!bound.has(combo), `${preset} (${combo}) is one of Paseo's own keys`);
});
