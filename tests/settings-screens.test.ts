import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { createSettings, SETTINGS_SCREEN } from "../client/settings-screens";
import { SETTINGS_CATEGORIES, readCategory, writeCategory, type KeyValue } from "../shared/settings-nav";
import { FOLLOW_UP_ICON } from "../client/follow-up-icon";

// Paseo 0.16 draws a plugin's settings screens as one native tab strip on the plugin's page (app
// plugins/settings/index.tsx SettingsTabs); 0.15 lists each one as its own row in the plugin's ••• menu.
// So 0.16 gets one screen per category and 0.15 keeps the single screen with Follow-up's own tabs.

const store = (): KeyValue => { const data = new Map<string, string>(); return { get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } }; };
type Registered = { id: string; title: string; icon: unknown; Component: (props: object) => { props: Record<string, unknown> } };
function fakeClient(version: "0.15" | "0.16") {
  const screens: Registered[] = []; const opened: string[] = [];
  const client: Record<string, unknown> = {
    addSettingsScreen(s: Registered) { screens.push(s); return () => { screens.splice(screens.indexOf(s), 1); }; },
    // Like the host (plugins/actions.ts): opening an id that isn't registered throws.
    openSettings(id: string) { if (!screens.some(s => s.id === id)) throw new Error(`Plugin settings screen is unavailable: ${id}`); opened.push(id); },
  };
  if (version === "0.16") { client.subscribe = () => () => undefined; client.addSidebarView = () => () => undefined; }
  return { client, screens, opened };
}
const Screen = (props: object) => ({ props: props as Record<string, unknown> });

test("Paseo 0.15: one settings screen, Follow-up's own tabs inside it", () => {
  const { client, screens } = fakeClient("0.15");
  createSettings(client as never, Screen as never, store());
  assert.deepEqual(screens.map(s => [s.id, s.title]), [[SETTINGS_SCREEN, "Follow-up"]]);
  assert.equal(screens[0].icon, FOLLOW_UP_ICON);
  assert.equal(screens[0].Component({}).props.category, undefined, "no category: the shell with its own tabs");
});

test("Paseo 0.16: one settings screen per category, in today's order, General first on the old id", () => {
  const { client, screens } = fakeClient("0.16");
  createSettings(client as never, Screen as never, store());
  assert.deepEqual(screens.map(s => s.title), SETTINGS_CATEGORIES.map(c => c.title));
  assert.equal(screens[0].id, SETTINGS_SCREEN, "saved links to the old screen land on General, the first tab");
  assert.equal(new Set(screens.map(s => s.id)).size, SETTINGS_CATEGORIES.length);
  screens.forEach((s, i) => {
    assert.equal(s.icon, SETTINGS_CATEGORIES[i].icon);
    assert.equal(s.Component({}).props.category, SETTINGS_CATEGORIES[i].id, `${s.title} renders only its own category`);
  });
});

test("deep links land on the right screen on both hosts", () => {
  for (const version of ["0.15", "0.16"] as const) {
    for (const cat of SETTINGS_CATEGORIES) {
      const s = store(); const { client, screens, opened } = fakeClient(version);
      const settings = createSettings(client as never, Screen as never, s);
      settings.open(cat.id);
      assert.equal(readCategory(s), cat.id, `${version}: ${cat.id} is the remembered category`);
      const landed = screens.find(r => r.id === opened.at(-1))!;
      const shown = landed.Component({}).props.category ?? readCategory(s);
      assert.equal(shown, cat.id, `${version}: open("${cat.id}") shows ${cat.id}`);
    }
  }
});

test("opening settings without a category reopens the last one; a press event is not a category", () => {
  for (const version of ["0.15", "0.16"] as const) {
    const s = store(); const { client, opened, screens } = fakeClient(version);
    const settings = createSettings(client as never, Screen as never, s);
    settings.open(); assert.equal(opened.at(-1), SETTINGS_SCREEN, `${version}: a device that never picked opens General`);
    writeCategory("reviewers", s);
    settings.open({ nativeEvent: {} });
    const landed = screens.find(r => r.id === opened.at(-1))!;
    assert.equal(landed.Component({}).props.category ?? readCategory(s), "reviewers", version);
  }
});

test("every settings link names its category; nobody writes the category and then opens settings", async () => {
  // updates.tsx used to writeCategory("general") then openSettings(): on 0.16 that depended on the order of two stores.
  const files = ["index.client.tsx", ...readdirSync("client").filter(f => /\.tsx?$/.test(f)).map(f => `client/${f}`)];
  for (const file of files) {
    if (file === "client/settings-screens.ts" || file === "client/settings.tsx") continue;
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\bwriteCategory\(/, `${file} opens settings with openSettings(category)`);
  }
  const panel = await readFile("client/panel.tsx", "utf8");
  assert.match(panel, /title="Project settings"[^\n]*onPress=\{\(\) => openSettings\("following"\)\}/, "the panel's Project settings opens Following");
});
