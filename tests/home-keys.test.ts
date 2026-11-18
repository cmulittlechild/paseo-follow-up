// the-selected-workspace-opens-with-enter (AGENTS.md invariant 56). Tom, 2.2.0: "I press cmd+/ to go to search,
// search a workspace, press enter and it open the panel, I want to press enter again to go to the workspace itself".
// Root cause: Home's Enter opened only a focused row (client/list-keys.ts, `if (!focused) return`). A search pick
// blurred the field (a single-line TextInput blurs on submit) while the query and its results stayed up, and Home's
// list keys were off while results showed, so the second Enter reached nothing. The same held for every way of
// selecting that leaves focus off the row: O, a ⌘K pick, coming back to Home, Esc out of the search. The browser walk is scripts/screenshots.mjs --only home-keys (home-keys.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { enterTarget, listMove, searchEnter } from "../shared/list-keys";
import { HOME_KEYS } from "../shared/home-keys";
import { CATCH_UP_KEYS } from "../shared/catch-up";

const src = (f: string) => readFile(join(import.meta.dirname, "..", f), "utf8");

test("a second Enter in Home's search opens the workspace it picked", () => {
  assert.equal(searchEnter({ item: "ws:billing", selected: null, query: "bill" }), "select", "the first Enter shows it in the pane");
  assert.equal(searchEnter({ item: "ws:billing", selected: "ws:billing", query: "bill" }), "open", "Enter again opens its chat");
  assert.equal(searchEnter({ item: "ws:invoice", selected: "ws:billing", query: "inv" }), "select", "another result is picked first");
  assert.equal(searchEnter({ item: null, selected: "ws:billing", query: "zzz" }), null, "no result: nothing");
  // Esc cleared the query: the field is empty, and Enter opens what is selected.
  assert.equal(searchEnter({ item: null, selected: "ws:billing", query: "" }), "open");
  assert.equal(searchEnter({ item: null, selected: null, query: " " }), null);
});

test("on Home the selection opens with Enter when nothing has focus, however it was selected", () => {
  // A click, a ⌘K pick, coming back to Home, Esc out of the search: the selection is on screen, focus is on the page.
  assert.equal(enterTarget({ focused: null, selectedKey: "ws:billing", mode: "select", onBody: true }), "ws:billing");
  // A focused row (the arrow walk, Tab) opens itself.
  assert.equal(enterTarget({ focused: "ws:invoice", selectedKey: "ws:billing", mode: "select", onBody: false }), "ws:invoice");
  // Enter on a button, chip or field stays that control's.
  assert.equal(enterTarget({ focused: null, selectedKey: "ws:billing", mode: "select", onBody: false }), null);
  // The sidebar view has no selection of its own to open: only a focused row opens there.
  assert.equal(enterTarget({ focused: null, selectedKey: "ws:billing", mode: "focus", onBody: true }), null);
});

test("O opens and S shows the keys, as in Catch up; never while typing or with a modifier", () => {
  assert.equal(listMove({ key: "o" }, false), "open");
  assert.equal(listMove({ key: "s" }, false), "keys");
  for (const key of ["o", "s"]) {
    assert.equal(listMove({ key }, true), null, `${key} types in a field`);
    assert.equal(listMove({ key, metaKey: true }, false), null);
    assert.equal(listMove({ key: key.toUpperCase(), shiftKey: true }, false), null);
  }
  // The same letter does the same thing as in Catch up.
  const cu = (action: string) => CATCH_UP_KEYS.find(k => k.action === action)?.key;
  assert.equal(cu("chat"), "O"); assert.equal(cu("keys"), "S");
  assert.ok(HOME_KEYS.some(k => k.key.includes("O") && /chat/i.test(k.what)));
  assert.ok(HOME_KEYS.some(k => k.key === "S"));
});

test("Home wires its Enter through the shared rules", async () => {
  const keys = await src("client/list-keys.ts");
  assert.match(keys, /enterTarget\(\{/, "the list's Enter asks enterTarget");
  assert.doesNotMatch(keys, /if \(!focused\) return;/, "Enter no longer needs a focused row");
  const home = await src("client/home.tsx");
  assert.match(home, /searchEnter\(\{/, "the search's Enter asks searchEnter");
  const chrome = await src("client/home-chrome.tsx");
  assert.match(chrome, /onEnter\(item \?\? null/, "an empty search's Enter reaches Home");
  assert.match(chrome, /blurOnSubmit=\{false\}/, "a search pick keeps the cursor in the field, so Enter again reaches it");
  assert.match(await src("client/home-list.tsx"), /enabled: !!keys && !touch, order/, "Home's keys stay on while a search shows results");
});

test("the keys sheet lists every Home key from the one list the handler reads", async () => {
  const keys = HOME_KEYS.map(k => k.key);
  for (const k of ["↑ ↓ / J K", "↵ / O", "/", "S"]) assert.ok(keys.includes(k), k);
  assert.match(await src("client/home.tsx"), /HOME_KEYS/);
});
