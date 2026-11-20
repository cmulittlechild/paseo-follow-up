import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, View, type StyleProp, type ViewProps, type ViewStyle } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { dismissRpc } from "../shared/contracts";
import { Pressable, Text } from "./text";
import { focusRing, keyboardFocus, type Theme } from "./kit";
import { useReducedMotion } from "./motion";
import { isLight, readable, solidFor, tint, withAlpha } from "./theme";
import { liveBriefKey, overviewKey, workspaceKey } from "./keys";
import { hasToastHost, pushToast, runAction } from "./toast-store";
import type { InboxStore } from "./inbox-store";

/**
 * Dismiss, the same on every Needs-you item (dismissing-anything-in-needs-you-sends-the-agent-nothing): a small muted x
 * in the card's top-right corner, next to its age. "This no longer needs me": the item leaves Needs you and every
 * count at once, the agent is sent nothing, and the toast's Undo brings it back. One control (DismissX), one request
 * (follow.dismiss), one toast.
 *
 * Where it shows: on a phone (no hover) always, muted, with a 40 px hit area (a real box, since react-native-web ignores hitSlop) rather than a bigger glyph.
 * On desktop it appears while the pointer is over its card or focus is inside it (RevealScope), and always on the card
 * that is selected (Catch up's card, Home's detail pane: `DismissReveal` "always"). Hidden is opacity 0, never
 * unmounted, so the card doesn't move when it appears and the keyboard and screen readers always reach it.
 *
 * Two clicks, in place (dismiss-takes-two-clicks-in-place): the first click (tap, Enter, Space, ⇧D in Catch up) arms the
 * x: it turns into a small red-tinted "Dismiss" pill on the same spot (solid red under the pointer), growing leftward over what sits beside it, so the
 * card never reflows. The second click on it dismisses. It disarms quietly on a click or tap anywhere else, Esc, focus
 * leaving it, the pointer leaving its card (after a short grace), or DISMISS_ARM_MS untouched. Only one x is armed at a
 * time, on every surface. No pop-up; Undo stays.
 */

/** As long as sign-off's Undo (6 s): the toast holds while the pointer or focus is on it. */
export const DISMISS_UNDO_MS = 6_000;
/** The x's tooltip and the second half of its accessibility label. */
export const DISMISS_HINT = "it no longer needs you, and the agent isn't messaged";
/** How long an armed x waits for its second click (paused while the pointer is on it). */
export const DISMISS_ARM_MS = 4_000;
/** How long the pointer may be off the armed x's card before it disarms (a wobble isn't leaving). */
export const DISMISS_LEAVE_GRACE_MS = 600;
/** What a screen reader hears when the x arms, and the armed x's tooltip. */
export const DISMISS_CONFIRM = "Press again to dismiss";

/** The one armed x, app-wide: arming another disarms this one. */
let armedX: object | null = null;
const armWatchers = new Set<() => void>();
const setArmed = (x: object | null) => { if (armedX === x) return; armedX = x; for (const f of armWatchers) f(); };
const watchArmed = (f: () => void) => { armWatchers.add(f); return () => { armWatchers.delete(f); }; };
/** Disarm whatever x is armed (a surface closing, a test resetting). */
export function disarmDismiss(): void { setArmed(null); }

export type DismissTarget = { workspaceId: string; key: string } | { agentId: string };
const targetKey = (t: DismissTarget) => "agentId" in t ? `agent:${t.agentId}` : `${t.workspaceId}:${t.key}`;

/** The inbox store, bound once by the client entry, so dismissing a brief updates the rows at once. */
let inbox: InboxStore | null = null;
export function bindDismissInbox(store: InboxStore | null): void { inbox = store; }

/** Dismiss one item, with Undo in the toast. `onDismissed` runs at once, before the request: the card moves on. */
export function useDismiss(): (target: DismissTarget, options?: { onDismissed?: () => void }) => void {
  const rpc = useRpc(dismissRpc);
  const toast = useToast();
  const cache = useQueryClient();
  const refresh = (t: DismissTarget) => {
    if ("agentId" in t) void cache.invalidateQueries({ queryKey: liveBriefKey(t.agentId) });
    else void cache.invalidateQueries({ queryKey: workspaceKey(t.workspaceId) });
    void cache.invalidateQueries({ queryKey: overviewKey });
  };
  const call = (t: DismissTarget, undo: boolean) => "agentId" in t && inbox ? inbox.dismiss(t.agentId, undo) : rpc({ ...t, ...(undo ? { undo: true } : {}) });
  const undo = (t: DismissTarget, name: string) => void runAction({ label: `Undo dismiss ${name}`, toast, run: () => call(t, true), onSuccess: () => refresh(t),
    success: () => `${name.charAt(0).toUpperCase()}${name.slice(1)} is back in Needs you`, failure: `Couldn't bring back ${name}` }, `dismiss:${targetKey(t)}`);
  return (t, options = {}) => {
    options.onDismissed?.();
    void runAction({ label: "Dismiss", toast, run: () => call(t, false), onSuccess: () => refresh(t), failure: "Couldn't dismiss it",
      // Already gone (merged, answered, sent elsewhere): nothing to say, the surface shows what happened.
      reconcile: () => refresh(t),
      success: r => {
        const message = `Dismissed ${r.name}. The agent wasn't messaged.`;
        if (!hasToastHost()) return message;
        pushToast("success", message, [{ label: "Undo", onPress: () => undo(t, r.name) }], { durationMs: DISMISS_UNDO_MS, keep: true });
        return null;
      } }, `dismiss:${targetKey(t)}`);
  };
}

/** "always": the card is the selected one (Catch up's card, Home's detail pane), so its x shows without hover. */
export const DismissReveal = createContext<"hover" | "always">("hover");
const Hovered = createContext<boolean>(false);
/** Whether the pointer is over the card (desktop web); null outside a RevealScope, where only the x itself knows. */
const PointerIn = createContext<boolean | null>(null);

type DomNode = { setAttribute?(k: string, v: string): void; contains?(other: unknown): boolean };
type Listen = { addEventListener?(type: string, f: (e: DomEvent) => void, capture?: boolean): void; removeEventListener?(type: string, f: (e: DomEvent) => void, capture?: boolean): void };
type DomEvent = { key?: string; target?: unknown; preventDefault?(): void; stopPropagation?(): void };

/**
 * A card whose x shows while the pointer is over it or focus is inside it (desktop web). Native and phones draw the x
 * always, so this is a plain View there.
 */
export function RevealScope({ children, style, ...rest }: { children: ReactNode; style?: StyleProp<ViewStyle> } & Omit<ViewProps, "style" | "children">) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // react-native-web forwards these to the DOM (as client/linked.tsx's hover does); React's onFocus/onBlur bubble, so
  // focus anywhere inside the card counts. Native ignores them: the x is always shown there.
  const web = Platform.OS === "web" ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false), onFocus: () => setFocused(true), onBlur: () => setFocused(false) } : {};
  return <View style={style} {...rest} {...(web as object)}><PointerIn.Provider value={Platform.OS === "web" ? hovered : null}><Hovered.Provider value={hovered || focused}>{children}</Hovered.Provider></PointerIn.Provider></View>;
}

/**
 * The small x. `label` names what it dismisses ("Dismiss Q3", "Dismiss #12 is approved"); the hint follows it. Quiet by
 * design: the muted foreground at 14 px (16 on phones), no fill until hovered, never the size or colour of an action.
 * Armed (the first click), it is a red "Dismiss" pill in the same place; the second click calls `onPress`.
 */
export function DismissX({ theme, compact, label, onPress, disabled = false }: { theme: Theme; compact: boolean; label: string; onPress: () => void; disabled?: boolean }) {
  const c = theme.colors;
  const reveal = useContext(DismissReveal);
  const hovered = useContext(Hovered);
  const pointerIn = useContext(PointerIn);
  const [focused, setFocused] = useState(false);
  const [over, setOver] = useState(false);
  // Keyboard focus (focus-visible) holds the timeout too: someone who armed it with Enter and is hearing "Press again
  // to dismiss" shouldn't lose it to a timer. A mouse click also focuses; that doesn't count.
  const [keyed, setKeyed] = useState(false);
  const reduced = useReducedMotion();
  const fade = useRef(new Animated.Value(1)).current;
  const me = useRef({}).current;
  const armed = useSyncExternalStore(watchArmed, () => armedX === me, () => false);
  const disarm = () => { if (armedX === me) setArmed(null); };
  const touch = compact || Platform.OS !== "web";
  const shown = touch || reveal === "always" || hovered || focused || armed;
  const tip = useRef<View>(null);
  useEffect(() => { if (Platform.OS === "web") (tip.current as unknown as DomNode | null)?.setAttribute?.("title", armed ? DISMISS_CONFIRM : `Dismiss: ${DISMISS_HINT}`); }, [armed]);
  // Gone (dismissed, the card moved on) or disabled: never leave an armed x behind.
  useEffect(() => () => disarm(), []);
  useEffect(() => { if (disabled) disarm(); }, [disabled, armed]);
  // The quiet timeout, paused while the pointer rests on the pill (someone about to click it).
  useEffect(() => { if (!armed || over || keyed) return; const t = setTimeout(disarm, DISMISS_ARM_MS); return () => clearTimeout(t); }, [armed, over, keyed]);
  // The pill fades in (140 ms, ease-out, opacity only) from the x; reduced motion swaps at once. Disarming is instant,
  // and the second press never waits on it.
  useEffect(() => {
    if (!armed) return;
    if (reduced) { fade.setValue(1); return; }
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 140, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web" }).start();
  }, [armed, reduced]);
  // The pointer leaving the card (it was in, now it isn't) disarms after a grace; coming back keeps it armed.
  const wasIn = useRef(pointerIn);
  useEffect(() => {
    const left = wasIn.current === true && pointerIn === false;
    wasIn.current = pointerIn;
    if (!armed || !left) return;
    const t = setTimeout(disarm, DISMISS_LEAVE_GRACE_MS);
    return () => clearTimeout(t);
  }, [armed, pointerIn]);
  // Web: a click or tap anywhere but this x, or Esc, disarms. Esc is taken (capture, before Catch up's keys and the
  // host's interrupt): pressing it here only disarms.
  useEffect(() => {
    if (!armed) return;
    const g = globalThis as unknown as Listen & { document?: Listen };
    const doc = g.document;
    if (typeof doc?.addEventListener !== "function" || typeof g.addEventListener !== "function") return;
    const onDown = (e: DomEvent) => { if (!(tip.current as unknown as DomNode | null)?.contains?.(e.target)) disarm(); };
    const onKey = (e: DomEvent) => { if (e.key !== "Escape") return; e.preventDefault?.(); e.stopPropagation?.(); disarm(); };
    doc.addEventListener("pointerdown", onDown, true);
    g.addEventListener("keydown", onKey, true);
    return () => { doc.removeEventListener?.("pointerdown", onDown, true); g.removeEventListener?.("keydown", onKey, true); };
  }, [armed]);
  const press = () => {
    if (armed) { disarm(); onPress(); return; }
    setArmed(me);
    AccessibilityInfo.announceForAccessibility?.(DISMISS_CONFIRM);
  };
  // Phones: a real 40 px box (react-native-web ignores hitSlop) pulled in by 6 px each side, so it lays out as 28 px;
  // native also gets 4 px of hitSlop, a 48 px target. The glyph stays small and muted.
  const box = touch ? 40 : 22;
  // Armed: wider by the pill, and the extra width is taken back with a negative left margin, so it lays out exactly as
  // the x did: nothing beside it moves, the pill draws over it (solid, so what's under it doesn't show through).
  // Desktop's pill keeps a 3 px inset on the right. Phones: a 24 px pill in the same 40 px box, so the target stays and
  // the weight doesn't outgrow the card's own age and chips.
  const wide = touch ? 80 : 69;
  const pull = touch ? -6 : 0;
  return <Pressable ref={tip} accessibilityRole="button" accessibilityLabel={armed ? `${label}. ${DISMISS_CONFIRM}` : `${label}: ${DISMISS_HINT}`} disabled={disabled} onPress={press}
    hitSlop={4} onFocus={() => { setFocused(true); setKeyed(Platform.OS === "web" && keyboardFocus()); }} onBlur={() => { setFocused(false); setKeyed(false); disarm(); }} onHoverIn={() => setOver(true)} onHoverOut={() => setOver(false)}
    style={(state: { hovered?: boolean; pressed: boolean; focused?: boolean }) => armed
      ? { ...focusRing(state.focused, c), width: wide, height: box, margin: pull, marginLeft: pull - (wide - box), borderRadius: box / 2, alignItems: "stretch", justifyContent: "center", zIndex: 1 }
      : { ...focusRing(state.focused, c), width: box, height: box, margin: pull, borderRadius: box / 2, alignItems: "center", justifyContent: "center",
        opacity: shown ? (disabled ? 0.4 : 1) : 0, backgroundColor: state.pressed ? c.surface2 : state.hovered ? withAlpha(c.foreground, 0.06) : "transparent" }}>
    {state => {
      const hot = state.pressed || !!(state as { hovered?: boolean }).hovered;
      // Web screen readers: react-native-web's announceForAccessibility is a no-op, so a polite live region (always
      // mounted, empty until armed) says it. Native announces through AccessibilityInfo above.
      const live = Platform.OS === "web" ? <Text accessibilityLiveRegion="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 }}>{armed ? DISMISS_CONFIRM : ""}</Text> : null;
      if (!armed) return <>{live}<Icon name="X" size={touch ? 16 : 14} color={hot ? c.foreground : c.foregroundMuted} /></>;
      // Armed at rest: a danger tint with danger ink and a hairline, over the page ground so what it covers doesn't show
      // through. It goes solid (white on deepened danger) only under the pointer or finger, the moment it acts. Red,
      // quietly: Dismiss is undoable, and a solid red pill at rest read as a new blocker on an amber card.
      const ink = isLight(c) ? solidFor(c.statusDanger) : readable(c.statusDanger, c);
      return <>{live}<Animated.View style={{ opacity: fade, height: touch ? 24 : 22, marginLeft: touch ? 6 : 0, marginRight: touch ? 6 : 3, borderRadius: touch ? 12 : 11, overflow: "hidden", backgroundColor: c.surface0 }}>
        <View style={{ flex: 1, borderRadius: touch ? 12 : 11, borderWidth: 1, alignItems: "center", justifyContent: "center",
          borderColor: hot ? "transparent" : withAlpha(c.statusDanger, 0.35),
          backgroundColor: hot ? solidFor(c.statusDanger, state.pressed ? 0.82 : 1) : tint(c.statusDanger, c) }}>
          <Text numberOfLines={1} style={{ color: hot ? "#ffffff" : ink, fontSize: 12, lineHeight: 14, fontWeight: "600" }}>Dismiss</Text>
        </View>
      </Animated.View></>;
    }}
  </Pressable>;
}
