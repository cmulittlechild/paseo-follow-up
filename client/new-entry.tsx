import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Text } from "./text";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useNewOpen } from "./new";
import type { NewKey } from "./search-key";

/**
 * The sidebar's New row (`addSidebarHeaderItem`, id "new"): a + and "New", with New's key on the right on desktop web.
 * It opens New the same way as ⌘K and the key (index.client.tsx `enterNew`) (on a phone, the list screen), and reads as active
 * while New is open. Reads nothing.
 */
export function NewSidebarRow(key: NewKey, enter: (openScreen: PluginSidebarItemProps["openScreen"]) => void) {
  return function FollowNewRow({ openScreen, theme }: PluginSidebarItemProps) {
    const label = useSyncExternalStore(key.subscribe, key.label, key.label);
    const open = useNewOpen();
    return <SidebarRow icon="Plus" label="New" active={open} onPress={() => enter(openScreen)}
      trailing={label && Platform.OS === "web" ? <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text> : undefined} />;
  };
}
