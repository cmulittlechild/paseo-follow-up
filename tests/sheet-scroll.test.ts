import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NATIVE_SCROLL_ALLOWED } from "../client/scroll-allowlist";

/**
 * sheet-content-scrolls-with-the-sheet (2026-11-15): on a phone, Report an issue's Send to list showed about six agents
 * and the rest (and "A new agent", drawn last) couldn't be reached. The picker was React Native's own ScrollView inside
 * Paseo's bottom sheet, which owns the pan gesture; only the kit's ScrollView/FlatList (@getpaseo/plugin/client/ui)
 * hand the gesture to the list inside a sheet (and are React Native's own everywhere else). Every client scroll view
 * comes from the kit, except the ones allowlisted in client/scroll-allowlist.ts with a reason.
 */
const root = join(import.meta.dirname, "..");
const NATIVE_SCROLL = /import\s+\{([^}]*)\}\s+from\s+"react-native"/g;

async function clientFiles(): Promise<string[]> {
  const out = ["index.client.tsx"];
  for (const f of await readdir(join(root, "client"))) if (/\.tsx?$/.test(f)) out.push(`client/${f}`);
  return out;
}

/** Value imports of ScrollView or FlatList from react-native (`type ScrollView` is only a ref type and is fine). */
export function nativeScrollImports(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(NATIVE_SCROLL)) for (const part of m[1].split(",").map(s => s.trim()).filter(Boolean)) {
    if (part.startsWith("type ")) continue;
    const name = part.split(/\s+as\s+/)[0].trim();
    if (name === "ScrollView" || name === "FlatList") names.push(name);
  }
  return names;
}

test("sheet-content-scrolls-with-the-sheet: no client file scrolls with React Native's own ScrollView or FlatList", async () => {
  const offenders: string[] = [];
  for (const f of await clientFiles()) {
    const names = nativeScrollImports(await readFile(join(root, f), "utf8"));
    for (const n of names) if (!NATIVE_SCROLL_ALLOWED[`${f}:${n}`]) offenders.push(`${f}: ${n}`);
  }
  assert.deepEqual(offenders, [], "import ScrollView/FlatList from @getpaseo/plugin/client/ui, or allowlist it in client/scroll-allowlist.ts with a reason");
});

test("sheet-content-scrolls-with-the-sheet: every allowlisted native scroll view is still there and says why", async () => {
  for (const [key, reason] of Object.entries(NATIVE_SCROLL_ALLOWED)) {
    const [file, name] = key.split(":");
    assert.ok(nativeScrollImports(await readFile(join(root, file), "utf8")).includes(name), `${key} no longer imports React Native's ${name}: remove it from the allowlist`);
    assert.ok(reason.length >= 40, `${key}: the reason must say why it never renders inside a host sheet or popover`);
  }
});

test("the guard reads value imports, not type imports or other names", () => {
  assert.deepEqual(nativeScrollImports(`import { Platform, ScrollView, View } from "react-native";`), ["ScrollView"]);
  assert.deepEqual(nativeScrollImports(`import { View, type ScrollView as NativeScrollView } from "react-native";`), []);
  assert.deepEqual(nativeScrollImports(`import {\n  FlatList,\n  View,\n} from "react-native";`), ["FlatList"]);
  assert.deepEqual(nativeScrollImports(`import { ScrollView } from "@getpaseo/plugin/client/ui";`), []);
});

test("Report an issue: the picker's scroll view is the kit's, and on phones it's the sheet's one scrollable, never nested", async () => {
  const src = await readFile(join(root, "client/report-issue.tsx"), "utf8");
  assert.match(src, /import \{[^}]*\bScrollView\b[^}]*\} from "@getpaseo\/plugin\/client\/ui"/);
  // A Paseo bottom sheet coordinates one scrollable (its body); on phones the agent list scrolls with it.
  const { pickerScrolls } = await import("../shared/report-send");
  assert.equal(pickerScrolls(true), false, "phones: no scroll view nested in the sheet's body");
  assert.equal(pickerScrolls(false), true, "desktop: the list scrolls inside, under the pinned new rows");
});
