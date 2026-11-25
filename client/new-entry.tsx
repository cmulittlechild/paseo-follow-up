import { useSyncExternalStore } from "react";
import { useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { displayPreferences } from "../shared/display";
import { isDesktopApp, isMac, newShortcutPreset, shortcutLabel } from "../shared/search-key";
import { errorText } from "./kit";
import { Platform } from "react-native";
import { Text } from "./text";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useNewOpen } from "./new";
import type { NewKey } from "./search-key";
import { subscribeDisplay } from "./display";
import { sidebarVisibility } from "./sidebar-visibility";
import { NEW_NAME } from "../shared/new-name";

/**
 * The sidebar's New row (`addSidebarHeaderItem`, id "new"): a + and "New", with New's key on the right on desktop web.
 * It opens New the same way as ⌘K and the key (index.client.tsx `enterNew`) (on a phone, the list screen), and reads as active
 * while New is open. Reads nothing.
 */
export function NewSidebarRow(key: NewKey, enter: (openScreen: PluginSidebarItemProps["openScreen"]) => void) {
  return function FollowNewRow({ openScreen, theme }: PluginSidebarItemProps) {
    const label = useSyncExternalStore(key.subscribe, key.label, key.label);
    const open = useNewOpen();
    return <SidebarRow icon="Plus" label={NEW_NAME} active={open} onPress={() => enter(openScreen)}
      trailing={label && Platform.OS === "web" ? <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text> : undefined} />;
  };
}

/**
 * The row is optional (new-row-is-optional): it follows the Display switch `enable_new_sidebar_row`, registered while
 * on and removed while off, on every device the developer uses and live when an agent's set_display changes it. It
 * registers at once (the default, so most hosts never flash) and the first Display read removes it when off. Off
 * touches nothing else: Home's + New, ⌘K and New's key keep opening New.
 */
export function contributeNewRow(client: Pick<PluginClientContext, "addSidebarHeaderItem">, key: NewKey, enter: (openScreen: PluginSidebarItemProps["openScreen"]) => void) {
  const row = sidebarVisibility(() => client.addSidebarHeaderItem({ id: "new", title: NEW_NAME, Component: NewSidebarRow(key, enter) }));
  row.set(true);
  const off = subscribeDisplay(values => row.set(values.enable_new_sidebar_row !== false));
  return () => { off(); row.dispose(); };
}

/**
 * The row's switch, one copy for Settings → New work and setup's tour (`NEW_ROW`): its value (null until read), the
 * hint naming New's key on web, and the write, which goes through the Display document like set_display.
 */
export function useNewRowSetting() {
  const display = useSettings(displayPreferences); const toast = useToast();
  const ready = display.status === "ready";
  const key = ready && Platform.OS === "web" ? shortcutLabel(newShortcutPreset(display.values.new_shortcut, isDesktopApp()), isMac()) : null;
  return {
    value: ready ? display.values.enable_new_sidebar_row : null,
    saving: ready ? display.saving : false,
    key,
    set: (enable_new_sidebar_row: boolean) => {
      if (display.status !== "ready") return;
      void display.save({ ...display.values, enable_new_sidebar_row }, display.revision).catch(e => toast.error(errorText(e)));
    },
  };
}
