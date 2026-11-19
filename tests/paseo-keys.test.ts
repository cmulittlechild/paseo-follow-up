import test from "node:test";
import assert from "node:assert/strict";
import { extractPaseoCombos, normalizeCombos, keyConflicts } from "../shared/paseo-keys";

test("bundle fixture expands Mod, decodes escapes, deduplicates and keeps both platform spellings", () => {
  const fixture = String.raw`[{combo:""},{combo:"Mod+/"},{combo:"Mod+Shift+/"},{combo:"Cmd+K"},{combo:"Ctrl+K"},{combo:"Cmd+\\"},{combo:"Mod+/"},{other:"Mod+J"}]`;
  assert.deepEqual(extractPaseoCombos(fixture), ["Cmd+/", "Cmd+K", "Cmd+Shift+/", "Cmd+\\", "Ctrl+/", "Ctrl+K", "Ctrl+Shift+/"]);
  assert.deepEqual(normalizeCombos(["Mod+Shift+k", "Cmd+Shift+K", "Shift+Ctrl+k"]), ["Cmd+Shift+K", "Ctrl+Shift+K"]);
});

test("an upstream collision fails even if the snapshot knows it; an unclaimed addition also needs review", () => {
  assert.deepEqual(keyConflicts(["Mod+/", "Mod+J"], ["Cmd+/", "Ctrl+/"], ["Mod+/"]), {
    collisions: ["Cmd+/", "Ctrl+/"], additions: ["Cmd+J", "Ctrl+J"],
  });
  assert.deepEqual(keyConflicts(["Mod+K"], ["Cmd+K", "Ctrl+K", "Mod+P"], ["Mod+Shift+K"]), { collisions: [], additions: [] });
});
