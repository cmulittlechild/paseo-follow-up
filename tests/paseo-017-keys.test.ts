import test from "node:test";
import assert from "node:assert/strict";
import { SEARCH_SHORTCUTS, shortcutCombos, searchShortcutOf } from "../shared/search-key";
import { displayPreferences } from "../shared/display";

// Paseo 0.17.0-beta.1's bundle adds combo:"Mod+/" and combo:"Mod+Shift+/".
test("Paseo 0.17's model picker keys are never offered as a search preset", () => {
  const modelPicker = new Set(["Cmd+/", "Ctrl+/", "Cmd+Shift+/", "Ctrl+Shift+/"]);
  for (const preset of SEARCH_SHORTCUTS) for (const combo of shortcutCombos(preset)) {
    assert.ok(!modelPicker.has(combo), `${preset} collides with Paseo 0.17: ${combo}`);
  }
});

test("a saved retired slash key reads as Shift K without losing the rest of Display", () => {
  assert.equal(searchShortcutOf("mod-slash"), "mod-shift-k");
  const saved = displayPreferences.schema.parse({ search_shortcut: "mod-slash", enable_inbox: false });
  assert.equal(saved.search_shortcut, "mod-shift-k");
  assert.equal(saved.enable_inbox, false);
});
