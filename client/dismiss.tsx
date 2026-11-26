import { tr } from "./i18n-text";
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
 * Where it shows: on a phone (no hover) always, muted, with a 44 px hit area (a real box, since react-native-web ignores hitSlop; DESIGN.md's compact target) rather than a bigger glyph.
 * On desktop it appears while the pointer is over its card or focus is inside it (RevealScope), and always on the card
 * that is selected (Catch up's card, Home's detail pane: `DismissReveal` "always"). Hidden is opacity 0, never
 * unmounted, so the card doesn't move when it appears and the keyboard and screen readers always reach it.
 *
 * Two clicks, in place (dismiss-takes-two-clicks-in-place, armed-dismiss-shows-remove-and-keep): the first click (tap,
 * Enter, Space, ⇧D in Catch up) arms the x: it turns into two small buttons on the same spot, a quiet tr("Keep") (backs out;
 * first in reading order, and where focus lands, so a second Enter keeps) and a red-tinted tr("Remove") (confirms; solid
 * red under the pointer), growing leftward over what sits beside it, so the card never reflows. It disarms quietly on
 * Keep, a click or tap anywhere else, Esc (focus goes back to the x), focus leaving the pair, the pointer leaving its
 * card (after a short grace), or DISMISS_ARM_MS untouched. The second click of a double-click never removes. Only one x
 * is armed at a time, on every surface. No pop-up; Undo stays.
 */

/** As long as sign-off's Undo (6 s): the toast holds while the pointer or focus is on it. */
export const DISMISS_UNDO_MS = 6_000;
/** The x's tooltip and the second half of its accessibility label. */
export const DISMISS_HINT = "it no longer needs you, and the agent isn't messaged";
/** How long an armed x waits for its second click (paused while the pointer is on it). */
export const DISMISS_ARM_MS = 4_000;
/** How long the pointer may be off the armed x's card before it disarms (a wobble isn't leaving). */
export const DISMISS_LEAVE_GRACE_MS = 600;
/** What a screen reader hears when the x arms. */
export const DISMISS_CONFIRM = "Remove, or Keep to cancel";

/** The one armed x, app-wide: arming another disarms this one. */
let armedX: object | null = null;
const armWatchers = new Set<() => void>();
const setArmed = (x: object | null) => { if (armedX === x) return; armedX = x; for (const f of armWatchers) f(); };
const watchArmed = (f: () => void) => { armWatchers.add(f); return () => { armWatchers.delete(f); }; };
/** Disarm whatever x is armed (a surface closing, a test resetting). */
export function disarmDismiss(): void { setArmed(null); }

/** A workspace's item, an agent's brief, or a raised Linear issue with no workspace (the Morning brief's Q8 item). */
export type DismissTarget = { workspaceId: string; key: string } | { agentId: string } | { issue: string };
const targetKey = (t: DismissTarget) => "agentId" in t ? `agent:${t.agentId}` : "issue" in t ? `issue:${t.issue}` : `${t.workspaceId}:${t.key}`;

/** The inbox store, bound once by the client entry, so dismissing a brief updates the rows at once. */
let inbox: InboxStore | null = null;
export function bindDismissInbox(store: InboxStore | null): void { inbox = store; }

/** Dismiss one item, with Undo in the toast. `onDismissed` runs at once, before the request: the card moves on. */
export function useDismiss(after?: () => void): (target: DismissTarget, options?: { onDismissed?: () => void }) => void {
  const rpc = useRpc(dismissRpc);
  const toast = useToast();
  const cache = useQueryClient();
  const refresh = (t: DismissTarget) => {
    if ("agentId" in t) void cache.invalidateQueries({ queryKey: liveBriefKey(t.agentId) });
    else if ("workspaceId" in t) void cache.invalidateQueries({ queryKey: workspaceKey(t.workspaceId) });
    void cache.invalidateQueries({ queryKey: overviewKey });
    after?.();
  };
  const call = (t: DismissTarget, undo: boolean) => "agentId" in t && inbox ? inbox.dismiss(t.agentId, undo) : rpc({ ...t, ...(undo ? { undo: true } : {}) });
  const undo = (t: DismissTarget, name: string) => void runAction({ label: `Undo remove ${name}`, toast, run: () => call(t, true), onSuccess: () => refresh(t),
    success: () => `${name.charAt(0).toUpperCase()}${name.slice(1)} is back in Needs you`, failure: `Couldn't bring back ${name}` }, `dismiss:${targetKey(t)}`);
  return (t, options = {}) => {
    options.onDismissed?.();
    void runAction({ label: tr("Remove"), toast, run: () => call(t, false), onSuccess: () => refresh(t), failure: "Couldn't remove it",
      // Already gone (merged, answered, sent elsewhere): nothing to say, the surface shows what happened.
      reconcile: () => refresh(t),
      success: r => {
        const message = `Removed ${r.name}. The agent wasn't messaged.`;
        if (!hasToastHost()) return message;
        pushToast("success", message, [{ label: tr("Undo"), onPress: () => undo(t, r.name) }], { durationMs: DISMISS_UNDO_MS, keep: true });
        return null;
      } }, `dismiss:${targetKey(t)}`);
  };
}

/** "always": the card is the selected one (Catch up's card, Home's detail pane), so its x shows without hover. */
export const DismissReveal = createContext<"hover" | "always">("hover");
const Hovered = createContext<boolean>(false);
/** Whether the pointer is over the card (desktop web); null outside a RevealScope, where only the x itself knows. */
const PointerIn = createContext<boolean | null>(null);

type DomNode = { setAttribute?(k: string, v: string): void; contains?(other: unknown): boolean; focus?(): void };
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


/** The armed pair's quiet button names the same item: "Remove Q1" → "Keep Q1". */
export const keepLabel = (label: string) => /^Remove\b/.test(label) ? label.replace(/^Remove\b/, tr("Keep")) : `Keep ${label}`;

type PressEvent = { detail?: number; relatedTarget?: unknown; nativeEvent?: { detail?: number; relatedTarget?: unknown } } | undefined;
/** The click count of a pointer press (the DOM's `detail`: 2 is a double-click's second click); 0 for keys and native. */
const clickCount = (e: PressEvent) => e?.nativeEvent?.detail ?? e?.detail ?? 0;

/**
 * The small x. `label` names what it removes ("Remove Q1", "Remove #12 is approved"); the hint follows it. Quiet by
 * design: the muted foreground at 14 px (16 on phones), no fill until hovered, never the size or colour of an action.
 * Armed (the first click), it is a quiet tr("Keep") and a red tr("Remove") in the same place; Remove calls `onPress`.
 */
export function DismissX({ theme, compact, label, onPress, disabled = false }: { theme: Theme; compact: boolean; label: string; onPress: () => void; disabled?: boolean }) {
  const c = theme.colors;
  const reveal = useContext(DismissReveal);
  const hovered = useContext(Hovered);
  const pointerIn = useContext(PointerIn);
  const [focused, setFocused] = useState(false);
  const [over, setOver] = useState(false);
  // Keyboard focus (focus-visible) holds the timeout too: someone who armed it with Enter and is hearing "Remove, or
  // Keep to cancel" shouldn't lose it to a timer. A mouse click also focuses; that doesn't count.
  const [keyed, setKeyed] = useState(false);
  const reduced = useReducedMotion();
  const fade = useRef(new Animated.Value(1)).current;
  const me = useRef({}).current;
  const armed = useSyncExternalStore(watchArmed, () => armedX === me, () => false);
  const disarm = () => { if (armedX === me) setArmed(null); };
  const touch = compact || Platform.OS !== "web";
  const shown = touch || reveal === "always" || hovered || focused || armed;
  const root = useRef<View>(null);
  const tip = useRef<View>(null);
  const keep = useRef<View>(null);
  /** A pointer went down inside the pair: the focus it moves (or drops, in Safari) isn't focus leaving. */
  const downInside = useRef(false);
  /** Disarmed from the keyboard (Esc, Keep): focus goes back to the x. */
  const refocus = useRef(false);
  /** Just armed with the pointer still where the x was, which is now Remove: it stays quiet (no solid red) until the
   * pointer leaves it once, so the loudest thing on the card is never one nobody chose to point at. */
  const [fresh, setFresh] = useState(false);
  const dom = (r: { current: View | null }) => r.current as unknown as DomNode | null;
  useEffect(() => { if (Platform.OS === "web" && !armed) dom(tip)?.setAttribute?.("title", `Remove: ${DISMISS_HINT}`); }, [armed]);
  // Gone (removed, the card moved on) or disabled: never leave an armed x behind.
  useEffect(() => () => disarm(), []);
  useEffect(() => { if (disabled) disarm(); }, [disabled, armed]);
  // Armed: focus lands on Keep (the safe default: a second Enter or Space keeps). Disarmed: the pair is gone, so its
  // focus is too, unless Esc or Keep hands it back to the x.
  useEffect(() => {
    if (armed) { setFresh(true); if (Platform.OS === "web") dom(keep)?.focus?.(); return; }
    setFocused(false); setKeyed(false);
    if (refocus.current) { refocus.current = false; dom(tip)?.focus?.(); }
  }, [armed]);
  // The quiet timeout, paused while the pointer rests on the pair (someone about to click it).
  useEffect(() => { if (!armed || over || keyed) return; const t = setTimeout(disarm, DISMISS_ARM_MS); return () => clearTimeout(t); }, [armed, over, keyed]);
  // The pair fades in (140 ms, ease-out, opacity only) from the x; reduced motion swaps at once. Disarming is instant,
  // and Remove never waits on it.
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
  const back = () => { refocus.current = Platform.OS === "web"; disarm(); };
  // Web: a click or tap anywhere but the pair, or Esc, disarms. Esc is taken (capture, before Catch up's keys and the
  // host's interrupt): pressing it here only disarms, and focus goes back to the x.
  useEffect(() => {
    if (!armed) return;
    const g = globalThis as unknown as Listen & { document?: Listen };
    const doc = g.document;
    if (typeof doc?.addEventListener !== "function" || typeof g.addEventListener !== "function") return;
    const onDown = (e: DomEvent) => { downInside.current = !!dom(root)?.contains?.(e.target); if (!downInside.current) disarm(); };
    const onKey = (e: DomEvent) => { if (e.key !== "Escape") return; e.preventDefault?.(); e.stopPropagation?.(); back(); };
    doc.addEventListener("pointerdown", onDown, true);
    g.addEventListener("keydown", onKey, true);
    return () => { doc.removeEventListener?.("pointerdown", onDown, true); g.removeEventListener?.("keydown", onKey, true); };
  }, [armed]);
  const arm = () => { setArmed(me); AccessibilityInfo.announceForAccessibility?.(DISMISS_CONFIRM); };
  // A double-click on the x lands its second click where Remove now is: that click never removes.
  const remove = (e?: PressEvent) => { if (clickCount(e) >= 2) return; disarm(); onPress(); };
  const focusIn = () => { setFocused(true); setKeyed(Platform.OS === "web" && keyboardFocus()); };
  // Focus leaving the pair (Tab past Remove, Shift+Tab before Keep) disarms; moving between Keep and Remove doesn't.
  const focusOut = (e?: PressEvent) => {
    setFocused(false); setKeyed(false);
    const inside = downInside.current; downInside.current = false;
    const to = e?.nativeEvent?.relatedTarget ?? e?.relatedTarget;
    if (inside || (to != null && dom(root)?.contains?.(to))) return;
    disarm();
  };
  // Sizes. Phones: every button is a real 44 px tall box (DESIGN.md's compact target; react-native-web ignores hitSlop)
  // pulled in by 8 px top and bottom, so it lays out as 28 px; the x stays a small muted glyph in it, the pair's pills are 28 px, with 8 px
  // between the two targets so a stray tap meant for Keep doesn't land on Remove. Desktop: 22 px, 6 px apart (room
  // for Keep's focus ring).
  const box = touch ? 44 : 22;
  const pull = touch ? -8 : 0;
  const pillH = touch ? 28 : 22;
  const keepW = touch ? 60 : 46, removeW = touch ? 76 : 62, gap = touch ? 8 : 6, inset = touch ? 6 : 3;
  // Armed: wider by the pair, and the extra width is taken back with a negative left margin, so it lays out exactly as
  // the x did: nothing beside it moves, the pair draws over it (solid, so what's under it doesn't show through).
  const wide = keepW + gap + removeW + inset;
  const layout: ViewStyle = armed
    ? { width: wide, height: box, margin: pull, marginLeft: pull - (wide - box), paddingRight: inset, zIndex: 1 }
    : { width: box, height: box, margin: pull };
  // Web screen readers: react-native-web's announceForAccessibility is a no-op, so a polite live region (always
  // mounted, empty until armed) says it. Native announces through AccessibilityInfo above.
  const live = Platform.OS === "web" ? <Text accessibilityLiveRegion="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 }}>{armed ? DISMISS_CONFIRM : ""}</Text> : null;
  const hoverWeb = Platform.OS === "web" ? { onMouseEnter: () => setOver(true), onMouseLeave: () => setOver(false) } : {};
  const fontSize = touch ? 13 : 12;
  const pill = (w: number) => ({ width: w, height: box, borderRadius: box / 2, justifyContent: "center" as const });
  return <View ref={root} testID="dismiss-x" style={layout} {...(hoverWeb as object)}>
    {live}
    {!armed ? <Pressable ref={tip} accessibilityRole="button" accessibilityLabel={`${label}: ${DISMISS_HINT}`} disabled={disabled} onPress={arm}
      hitSlop={4} onFocus={focusIn} onBlur={() => { setFocused(false); setKeyed(false); }}
      style={(state: { hovered?: boolean; pressed: boolean; focused?: boolean }) => ({ ...focusRing(state.focused, c), flex: 1, borderRadius: box / 2, alignItems: "center", justifyContent: "center",
        opacity: shown ? (disabled ? 0.4 : 1) : 0, backgroundColor: state.pressed ? c.surface2 : state.hovered ? withAlpha(c.foreground, 0.06) : "transparent" })}>
      {state => <Icon name="X" size={touch ? 16 : 14} color={state.pressed || (state as { hovered?: boolean }).hovered ? c.foreground : c.foregroundMuted} />}
    </Pressable>
    : <Animated.View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap, opacity: fade }}>
      {/* One solid ground under both pills and the gap between them, so the age or title they cover never shows through. */}
      <View style={{ position: "absolute", left: 0, right: 0, top: (box - pillH) / 2, height: pillH, borderRadius: pillH / 2, backgroundColor: c.surface0 }} />
      {/* Keep: the way back, quiet and neutral (the card's own ground, a foreground hairline that still reads as a button
          in dark, body ink), first in reading order. */}
      <Pressable ref={keep} accessibilityRole="button" accessibilityLabel={keepLabel(label)} hitSlop={touch ? 0 : 2} onPress={back} onFocus={focusIn} onBlur={focusOut as () => void}
        style={(state: { pressed: boolean; focused?: boolean }) => ({ ...focusRing(state.focused, c), ...pill(keepW) })}>
        {state => {
          const hot = state.pressed || !!(state as { hovered?: boolean }).hovered;
          return <View style={{ height: pillH, borderRadius: pillH / 2, borderWidth: 1, borderColor: withAlpha(c.foreground, isLight(c) ? 0.18 : 0.28), backgroundColor: hot ? c.surface2 : c.surface0, alignItems: "center", justifyContent: "center" }}>
            <Text numberOfLines={1} style={{ color: c.foreground, fontSize, lineHeight: 14, fontWeight: "500" }}>{tr("Keep")}</Text>
          </View>;
        }}
      </Pressable>
      {/* Remove: a danger tint with danger ink and a hairline at rest, over the page ground so what it covers doesn't
          show through; solid (white on deepened danger) only under the pointer or finger, the moment it acts. Red,
          quietly: removing is undoable, and a solid red pill at rest read as a new blocker on an amber card. */}
      <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={touch ? 0 : 2} onPress={remove as () => void} onFocus={focusIn} onBlur={focusOut as () => void} onHoverOut={() => setFresh(false)}
        style={(state: { pressed: boolean; focused?: boolean }) => ({ ...focusRing(state.focused, c), ...pill(removeW) })}>
        {state => {
          const hot = state.pressed || (!fresh && !!(state as { hovered?: boolean }).hovered);
          const ink = isLight(c) ? solidFor(c.statusDanger) : readable(c.statusDanger, c);
          return <View style={{ height: pillH, borderRadius: pillH / 2, overflow: "hidden", backgroundColor: c.surface0 }}>
            <View style={{ flex: 1, borderRadius: pillH / 2, borderWidth: 1, alignItems: "center", justifyContent: "center",
              borderColor: hot ? "transparent" : withAlpha(c.statusDanger, 0.35),
              backgroundColor: hot ? solidFor(c.statusDanger, state.pressed ? 0.82 : 1) : tint(c.statusDanger, c) }}>
              <Text numberOfLines={1} style={{ color: hot ? "#ffffff" : ink, fontSize, lineHeight: 14, fontWeight: "600" }}>{tr("Remove")}</Text>
            </View>
          </View>;
        }}
      </Pressable>
    </Animated.View>}
  </View>;
}
