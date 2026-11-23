import { useState } from "react";
import { Platform, View } from "react-native";
import { Pressable, Text } from "./text";
import { Icon } from "@getpaseo/plugin/client/ui";
import { isMac } from "../shared/search-key";
import type { Bar, BarButton } from "../shared/new-view";
import { withAlpha, type Colors } from "./theme";

/**
 * New's action row, on its own so any surface can mount it (New's dialog, the Morning brief's queue): the bar from
 * `actionBar` (shared/new-view.ts) with the first action filled (↵), the second outlined (⌥↵), the rest under More, or
 * Open it when the source already has a workspace. It starts nothing itself: `onAction(id)` and `onOpen(workspaceId)`
 * are the caller's (New calls follow.dispatch with that action). `more`/`setMore` let a caller control the More
 * list; without them the row keeps its own.
 */

type Hover = { hovered?: boolean; pressed?: boolean };

/** A tappable list of choices under a control (More's actions; New's pickers). */
export function Choices<T extends string>({ items, onPick, c, compact }: { items: { id: T; label: string; hint?: string; on?: boolean }[]; onPick: (id: T) => void; c: Colors; compact: boolean }) {
  return <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface0, overflow: "hidden", marginTop: 6 }}>
    {items.map((it, i) => <Pressable key={it.id} accessibilityRole="button" accessibilityState={{ selected: !!it.on }} onPress={() => onPick(it.id)}
      style={(s: Hover) => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderTopWidth: i ? 1 : 0, borderTopColor: c.border, backgroundColor: s.hovered || s.pressed ? c.surface2 : "transparent" })}>
      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: compact ? 14 : 13, flexShrink: 1 }}>{it.label}</Text>
      {it.hint && <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, flexShrink: 1 }}>{it.hint}</Text>}
      <View style={{ flex: 1 }} />
      {it.on && <Icon name="Check" size={14} color={c.foreground} />}
    </Pressable>)}
  </View>;
}

/** A keyboard focus ring (web): the accent, offset from the control. */
export const focusRing = (c: Colors, focused: boolean | undefined) => focused && Platform.OS === "web" ? { outlineWidth: 2, outlineStyle: "solid", outlineColor: c.accent, outlineOffset: 2 } as object : {};

/**
 * One bar button. Filled when primary; a disabled primary drops its fill (neutral surface, muted text) so it never
 * reads as live. `trailing` draws its icon after the label (More ▾).
 */
/** `small`: a desktop row's own action (32px, DESIGN's desktop control), not a dialog's bar. Phones stay 44. */
export function BarBtn({ b, primary, c, compact, disabled, onPress, grow, trailing, small }: { b: BarButton | { name: string; icon: string; key: string | null }; primary: boolean; c: Colors; compact: boolean; disabled: boolean; onPress: () => void; grow?: boolean; trailing?: boolean; small?: boolean }) {
  const filled = primary && !disabled;
  const fg = filled ? c.accentForeground : disabled ? c.foregroundMuted : c.foreground;
  const icon = <Icon name={b.icon} size={small && !compact ? 14 : 15} color={fg} />;
  return <Pressable accessibilityRole="button" accessibilityLabel={b.key && Platform.OS === "web" ? `${b.name} (${b.key})` : b.name} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={(s: Hover & { focused?: boolean }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: small && !compact ? 6 : 8, minHeight: compact ? (primary ? 48 : 44) : small ? 32 : 36, paddingHorizontal: small && !compact ? 10 : 14, borderRadius: 8,
      // A grown button takes the free width but never less than its name: the row wraps instead (an action's name is never cut).
      ...(grow ? { flexGrow: 1 } : {}),
      ...(filled ? { backgroundColor: s.pressed ? withAlpha(c.accent, 0.85) : s.hovered ? withAlpha(c.accent, 0.92) : c.accent }
        : { borderWidth: 1, borderColor: c.border, backgroundColor: disabled ? c.surface1 : s.pressed ? c.surface2 : s.hovered ? c.surface1 : c.surface0 }),
      ...focusRing(c, s.focused) })}>
    {!trailing && icon}
    <Text numberOfLines={1} style={{ color: fg, fontSize: compact ? 15 : small ? 12 : 13, fontWeight: "600", flexShrink: 0 }}>{b.name}</Text>
    {trailing && icon}
    {b.key && !compact && Platform.OS === "web" && <Text style={{ color: fg, opacity: 0.75, fontSize: 12 }}>{b.key === "⌥↵" && !isMac() ? "Alt ↵" : b.key}</Text>}
  </Pressable>;
}

export function ActionRow({ bar, c, compact, onAction, onOpen, more: moreProp, setMore: setMoreProp }: { bar: Bar; c: Colors; compact: boolean; onAction: (id: string) => void; onOpen: (workspaceId: string) => void; more?: boolean; setMore?: (v: boolean) => void }) {
  const [ownMore, setOwnMore] = useState(false);
  const more = moreProp ?? ownMore; const setMore = setMoreProp ?? setOwnMore;
  if (bar.kind === "existing") {
    const off = !!bar.disabled;
    const moreOthers = bar.more.length > 0 && <BarBtn c={c} compact={compact} primary={false} disabled={off} trailing b={{ name: "More", icon: more ? "ChevronUp" : "ChevronDown", key: null }} onPress={() => setMore(!more)} />;
    const open = <BarBtn c={c} compact={compact} primary disabled={false} onPress={() => onOpen(bar.workspaceId)} b={{ name: "Open it", icon: "ExternalLink", key: "↵" }} />;
    const others = bar.others.map(b => <BarBtn key={b.id} c={c} compact={compact} primary={false} disabled={off} b={b} grow={compact} onPress={() => onAction(b.id)} />);
    return <View style={{ gap: 8 }}>
      {more && !off && <Choices c={c} compact={compact} items={bar.more.map(b => ({ id: b.id, label: b.name }))} onPick={id => { setMore(false); onAction(id); }} />}
      {compact ? <>
        {open}
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{off ? `Or start another workspace: ${bar.disabled}` : "Or start another workspace:"}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{others}{moreOthers}</View>
      </> : <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        {open}
        <Text style={{ color: c.foregroundMuted, fontSize: 12, marginLeft: 8 }}>{off ? bar.disabled : "or start another:"}</Text>
        {others}{moreOthers}
      </View>}
    </View>;
  }
  const disabled = !!bar.disabled;
  const moreBtn = bar.more.length > 0 && <BarBtn c={c} compact={compact} primary={false} disabled={disabled} trailing b={{ name: "More", icon: more ? "ChevronUp" : "ChevronDown", key: null }} onPress={() => setMore(!more)} />;
  return <View style={{ gap: 8 }}>
    {more && !disabled && <Choices c={c} compact={compact} items={bar.more.map(b => ({ id: b.id, label: b.name }))} onPick={id => { setMore(false); onAction(id); }} />}
    {bar.disabled && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{bar.disabled}</Text>}
    {compact ? <>
      {bar.primary && <BarBtn c={c} compact primary disabled={disabled} b={bar.primary} onPress={() => onAction(bar.primary!.id)} />}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {bar.second && <BarBtn c={c} compact primary={false} disabled={disabled} b={bar.second} grow onPress={() => onAction(bar.second!.id)} />}
        {moreBtn}
      </View>
    </> : <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {bar.primary && <BarBtn c={c} compact={false} primary disabled={disabled} b={bar.primary} onPress={() => onAction(bar.primary!.id)} />}
      {bar.second && <BarBtn c={c} compact={false} primary={false} disabled={disabled} b={bar.second} onPress={() => onAction(bar.second!.id)} />}
      {moreBtn}
    </View>}
  </View>;
}

