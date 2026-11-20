import { createElement, type ComponentType } from "react";
import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { FOLLOW_UP_ICON } from "./follow-up-icon";
import { SETTINGS_CATEGORIES, deviceStorage, isCategory, readCategory, writeCategory, type KeyValue, type SettingsCategory } from "../shared/settings-nav";

/**
 * Where Follow-up's settings live in Paseo's Settings (`settings-link-lands-on-its-category`).
 *
 * Paseo 0.16 draws a plugin's settings screens as one native tab strip on the plugin's page (the app's
 * plugins/settings/index.tsx `SettingsTabs`, unchanged in 0.17.0-beta.1), so there each category is its own screen
 * and Follow-up draws no tabs of its own. Paseo 0.15 lists every settings screen as its own row in the plugin's •••
 * menu, so there it keeps one screen, "Follow-up", with its own tabs (`FollowSettings` without a category).
 *
 * General keeps the old screen id, so a saved link or restored route to it lands on the first tab. Every link into
 * settings goes through `open(category)`: it remembers the category and opens the screen that shows it; with no
 * category it reopens the last one this device showed.
 */
export const SETTINGS_SCREEN = "projects";
const screenId = (category: SettingsCategory) => category === "general" ? SETTINGS_SCREEN : category;

/** The 0.16 app's client API (feeds, sidebar views): fixed for the app's lifetime. */
export const hasNativeSettingsTabs = (client: object) => {
  const c = client as { subscribe?: unknown; addSidebarView?: unknown };
  return typeof c.subscribe === "function" && typeof c.addSidebarView === "function";
};

export type SettingsScreenComponent = ComponentType<PluginSurfaceProps & { category?: SettingsCategory }>;

export function createSettings(client: Pick<PluginClientContext, "addSettingsScreen" | "openSettings">, Screen: SettingsScreenComponent, store: KeyValue = deviceStorage) {
  const native = hasNativeSettingsTabs(client);
  const removers = native
    ? SETTINGS_CATEGORIES.map(cat => client.addSettingsScreen({ id: screenId(cat.id), title: cat.title, icon: cat.icon,
      Component: (props: PluginSurfaceProps) => createElement(Screen, { ...props, category: cat.id }) }))
    : [client.addSettingsScreen({ id: SETTINGS_SCREEN, title: "Follow-up", icon: FOLLOW_UP_ICON, Component: (props: PluginSurfaceProps) => createElement(Screen, props) })];
  /** `category` may be anything a caller passes (a press event too): only a known category counts. */
  const open = (category?: unknown) => {
    if (isCategory(category)) writeCategory(category, store);
    client.openSettings(native ? screenId(readCategory(store)) : SETTINGS_SCREEN);
  };
  return { native, open, remove: () => { for (const r of removers) r(); } };
}
