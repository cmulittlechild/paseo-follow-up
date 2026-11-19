import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, View, type StyleProp, type ViewProps, type ViewStyle } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { dismissRpc } from "../shared/contracts";
import { Pressable } from "./text";
import { focusRing, type Theme } from "./kit";
import { withAlpha } from "./theme";
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
 */

/** As long as sign-off's Undo (6 s): the toast holds while the pointer or focus is on it. */
export const DISMISS_UNDO_MS = 6_000;
/** The x's tooltip and the second half of its accessibility label. */
export const DISMISS_HINT = "it no longer needs you, and the agent isn't messaged";

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

type DomNode = { addEventListener(type: string, f: () => void): void; removeEventListener(type: string, f: () => void): void; setAttribute?(k: string, v: string): void };

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
  return <View style={style} {...rest} {...(web as object)}><Hovered.Provider value={hovered || focused}>{children}</Hovered.Provider></View>;
}

/**
 * The small x. `label` names what it dismisses ("Dismiss Q3", "Dismiss #12 is approved"); the hint follows it. Quiet by
 * design: the muted foreground at 14 px (16 on phones), no fill until hovered, never the size or colour of an action.
 */
export function DismissX({ theme, compact, label, onPress, disabled = false }: { theme: Theme; compact: boolean; label: string; onPress: () => void; disabled?: boolean }) {
  const c = theme.colors;
  const reveal = useContext(DismissReveal);
  const hovered = useContext(Hovered);
  const [focused, setFocused] = useState(false);
  const touch = compact || Platform.OS !== "web";
  const shown = touch || reveal === "always" || hovered || focused;
  const tip = useRef<View>(null);
  useEffect(() => { if (Platform.OS === "web") (tip.current as unknown as DomNode | null)?.setAttribute?.("title", `Dismiss: ${DISMISS_HINT}`); }, []);
  // Phones: a real 40 px box (react-native-web ignores hitSlop) pulled in by 6 px each side, so it lays out as 28 px;
  // native also gets 4 px of hitSlop, a 48 px target. The glyph stays small and muted.
  const box = touch ? 40 : 22;
  return <Pressable ref={tip} accessibilityRole="button" accessibilityLabel={`${label}: ${DISMISS_HINT}`} disabled={disabled} onPress={onPress}
    hitSlop={4} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={(state: { hovered?: boolean; pressed: boolean; focused?: boolean }) => ({ ...focusRing(state.focused, c), width: box, height: box, margin: touch ? -6 : 0, borderRadius: box / 2, alignItems: "center", justifyContent: "center",
      opacity: shown ? (disabled ? 0.4 : 1) : 0, backgroundColor: state.pressed ? c.surface2 : state.hovered ? withAlpha(c.foreground, 0.06) : "transparent" })}>
    {state => <Icon name="X" size={touch ? 16 : 14} color={(state as { hovered?: boolean }).hovered ? c.foreground : c.foregroundMuted} />}
  </Pressable>;
}
