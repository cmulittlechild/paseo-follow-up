// A scrolling pane with a bar docked under it (`a-focused-field-and-its-send-stay-in-view`). Home's detail pane, the
// Overseer's pane and setup draw through it, so none of them handles the keyboard or a focused field its own way.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, Platform, TextInput, View, findNodeHandle, type StyleProp, type ViewStyle } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { KEYBOARD_MIN, dockState, isField, keyboardOverlap, revealFocused, type DockNode, type DockState } from "./dock";

type Doc = { activeElement?: DockNode | null };
type Viewport = { height: number; offsetTop: number; addEventListener(e: "resize" | "scroll", f: () => void): void; removeEventListener(e: "resize" | "scroll", f: () => void): void };
type Win = { innerHeight: number; innerWidth: number; visualViewport?: Viewport; addEventListener(e: "resize", f: () => void): void; removeEventListener(e: "resize", f: () => void): void };
type DomNode = DockNode & { contains(n: unknown): boolean; addEventListener(e: string, f: (e: { target: unknown }) => void): void; removeEventListener(e: string, f: (e: { target: unknown }) => void): void };

/**
 * Phones: whether the on-screen keyboard is up, and how much of the page it covers. On the web the keyboard either
 * shrinks the visual viewport over an unchanged page (iOS Safari, Chrome's default: `overlap`) or resizes the page
 * itself (`interactive-widget=resizes-content`: the window got shorter at the same width). Native reads Keyboard.
 */
export function useKeyboard(compact: boolean): { up: boolean; overlap: number } {
  const [k, setK] = useState({ up: false, overlap: 0 });
  useEffect(() => {
    if (!compact) return;
    if (Platform.OS === "web") {
      const win = globalThis as unknown as Win;
      const vv = win.visualViewport;
      let tallest = win.innerHeight, width = win.innerWidth;
      const check = () => {
        if (win.innerWidth !== width) { width = win.innerWidth; tallest = win.innerHeight; }
        tallest = Math.max(tallest, win.innerHeight);
        const overlap = vv ? keyboardOverlap({ innerHeight: win.innerHeight, viewportHeight: vv.height, offsetTop: vv.offsetTop }) : 0;
        const up = overlap > KEYBOARD_MIN || tallest - win.innerHeight > KEYBOARD_MIN;
        setK(p => p.up === up && p.overlap === overlap ? p : { up, overlap: up ? overlap : 0 });
      };
      vv?.addEventListener("resize", check); vv?.addEventListener("scroll", check); win.addEventListener("resize", check);
      return () => { vv?.removeEventListener("resize", check); vv?.removeEventListener("scroll", check); win.removeEventListener("resize", check); };
    }
    // Native: the host keeps the pane above the keyboard; the pane only needs to know it is up.
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setK({ up: true, overlap: 0 }));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setK({ up: false, overlap: 0 }));
    return () => { show.remove(); hide.remove(); };
  }, [compact]);
  return k;
}

/**
 * The pane: `header`, a scroll view holding `children`, and the bar `dock(yields)` draws under it. On a phone, while
 * a field in the pane has focus or the keyboard is up, `yields` is true and the dock drops its extras (Home's Sign
 * off row, setup's Back and Continue), the pane stops above the keyboard, and the focused field's primary form (the
 * field with its Send, marked PRIMARY_FORM) scrolls into view, again whenever the keyboard or the dock changes size.
 */
export function DockedPane({ compact, header, children, dock, style, contentContainerStyle, scrollRef }: {
  compact: boolean; header?: ReactNode | ((s: DockState) => ReactNode); children: ReactNode; dock?: (s: DockState) => ReactNode;
  style?: StyleProp<ViewStyle>; contentContainerStyle?: StyleProp<ViewStyle>;
  scrollRef?: React.MutableRefObject<unknown>;
}) {
  const root = useRef<View | null>(null);
  const dockRef = useRef<View | null>(null);
  const ownScroll = useRef<unknown>(null);
  const scroll = scrollRef ?? ownScroll;
  const [focus, setFocus] = useState({ field: false, inDock: false });
  const keyboard = useKeyboard(compact);
  const state = dockState({ compact, fieldFocused: focus.field, fieldInDock: focus.inDock, keyboardUp: keyboard.up });
  const yields = state.yields;
  const inDock = (n: unknown) => !!n && !!(dockRef.current as unknown as DomNode | null)?.contains(n);
  // Web: track focus inside the pane, and keep the focused field's form on screen.
  const reveal = () => {
    if (Platform.OS !== "web") return;
    const node = root.current as unknown as DomNode | null;
    const active = (globalThis as { document?: Doc }).document?.activeElement;
    if (node && active && node.contains(active)) revealFocused(active);
  };
  useEffect(() => {
    if (Platform.OS !== "web" || !compact) return;
    const node = root.current as unknown as DomNode | null;
    if (!node) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, f: () => void) => { const t = setTimeout(() => { timers.delete(t); f(); }, ms); timers.add(t); };
    const onIn = (e: { target: unknown }) => {
      if (!isField(e.target as DockNode)) return;
      setFocus({ field: true, inDock: inDock(e.target) });
      // Once the dock has yielded and the keyboard has settled.
      later(0, reveal); later(320, reveal);
    };
    const onOut = () => later(0, () => {
      const active = (globalThis as { document?: Doc }).document?.activeElement;
      const field = !!active && node.contains(active) && isField(active);
      setFocus({ field, inDock: field && inDock(active) });
    });
    node.addEventListener("focusin", onIn); node.addEventListener("focusout", onOut);
    return () => { node.removeEventListener("focusin", onIn); node.removeEventListener("focusout", onOut); timers.forEach(clearTimeout); };
  }, [compact]);
  useEffect(() => { if (yields) { reveal(); const t = setTimeout(reveal, 320); return () => clearTimeout(t); } }, [yields, state.typingInContent, keyboard.overlap]);
  // Native: the focused input, with room below it for its Send, once the keyboard is up.
  useEffect(() => {
    if (Platform.OS === "web" || !keyboard.up) return;
    const input = (TextInput as unknown as { State?: { currentlyFocusedInput?(): unknown } }).State?.currentlyFocusedInput?.();
    const handle = input ? findNodeHandle(input as never) : null;
    const s = scroll.current as { scrollResponderScrollNativeHandleToKeyboard?(h: number, extra: number, prevent: boolean): void } | null;
    if (handle) s?.scrollResponderScrollNativeHandleToKeyboard?.(handle, NATIVE_SEND_ROOM, true);
  }, [keyboard.up]);
  return <View ref={root} style={[{ flex: 1 }, style, keyboard.overlap ? { paddingBottom: keyboard.overlap } : null]}>
    {typeof header === "function" ? header(state) : header}
    <ScrollView ref={scroll as never} style={{ flex: 1 }} contentContainerStyle={contentContainerStyle} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    <View ref={dockRef}>{dock?.(state)}</View>
  </View>;
}

/** Native: what is kept clear under the focused input, about one row of actions (Send) plus the gap above it. */
const NATIVE_SEND_ROOM = 96;
