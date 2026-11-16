import { useEffect, useRef, useState, type ReactNode } from "react";
import { PanResponder, Platform, View, type LayoutChangeEvent } from "react-native";
import { withAlpha } from "./theme";
import type { Theme } from "./kit";
import { paneBounds, sideWidth, toFraction } from "../shared/split";

/**
 * side-panes-are-resizable: every desktop layout that puts a side pane next to a flexible one draws it through
 * ResizableSplit, so the developer can drag the divider (or move it with the keyboard) and the share they chose is kept.
 * The pane's width is a fraction of the split's width, clamped so both sides stay usable. Compact layouts never draw it:
 * they stack the two instead. Guarded by tests/side-panes.test.ts (client/pane-allowlist.ts lists the exceptions).
 *
 * Cheap while dragging: the width lives here, coalesced to one update per frame; `main` and `side` are elements the
 * parent built, so a drag re-renders only this frame, never their trees. The fraction is committed once, on release.
 */
export type SplitProps = {
  theme: Theme;
  main: ReactNode;
  side: ReactNode;
  /** The side pane's share of the width (from settings); undefined while they load, which draws `defaultFraction`. */
  fraction: number | undefined;
  defaultFraction: number;
  /** The side pane is never narrower than this, nor the main side narrower than `minMain` (px). */
  minSide: number;
  minMain: number;
  /** The persisted range of the fraction (the setting's own bounds). */
  range: [number, number];
  /** Called once per drag or key press with the new fraction. */
  onCommit: (fraction: number) => void;
  /** What the side pane is, for the handle's label ("Resize the detail pane"). */
  label: string;
  testID?: string;
};

type Doc = { body: { style: { cursor: string; userSelect: string } } };
const doc = () => (Platform.OS === "web" ? (globalThis as { document?: Doc }).document : undefined);
const STEP = 0.02;
const BIG_STEP = 0.1;
const HIT = 11;

export function ResizableSplit({ theme, main, side, fraction, defaultFraction, minSide, minMain, range, onCommit, label, testID }: SplitProps) {
  const c = theme.colors;
  const [total, setTotal] = useState(0);
  const [live, setLive] = useState<number | null>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [dragging, setDragging] = useState(false);
  const chosen = fraction ?? defaultFraction;
  const width = live ?? sideWidth(chosen, total, minSide, minMain);
  const [minW, maxW] = paneBounds(total, minSide, minMain);

  // Refs for the responder, which is built once.
  const state = useRef({ start: 0, width, total, frame: 0 as unknown as ReturnType<typeof requestAnimationFrame> | 0, next: width });
  state.current.total = total;
  if (live == null) state.current.width = width;

  const clamp = (w: number) => Math.round(Math.min(maxOf(), Math.max(minOf(), w)));
  const minOf = () => paneBounds(state.current.total, minSide, minMain)[0];
  const maxOf = () => paneBounds(state.current.total, minSide, minMain)[1];
  /** Saves the fraction for a width; false when it's the one already saved (nothing to wait for). */
  const commit = (w: number) => {
    const next = toFraction(w, state.current.total, range);
    if (next === chosenRef.current) return false;
    onCommit(next);
    return true;
  };
  const chosenRef = useRef(chosen); chosenRef.current = chosen;
  const commitRef = useRef(commit); commitRef.current = commit;

  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      state.current.start = state.current.width; state.current.next = state.current.width;
      setDragging(true); setLive(state.current.width);
      const d = doc(); if (d) { d.body.style.cursor = "col-resize"; d.body.style.userSelect = "none"; }
    },
    onPanResponderMove: (_e, g) => {
      // The pane is on the right: dragging left widens it.
      state.current.next = clamp(state.current.start - g.dx);
      if (state.current.frame) return;
      const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16) as unknown as number;
      state.current.frame = raf(() => { state.current.frame = 0; setLive(state.current.next); });
    },
    onPanResponderRelease: () => end(),
    onPanResponderTerminate: () => end(),
  })).current;
  function end() {
    const d = doc(); if (d) { d.body.style.cursor = ""; d.body.style.userSelect = ""; }
    const w = state.current.next;
    state.current.width = w;
    setDragging(false);
    // Keep the dragged width until the saved fraction comes back, so the pane never jumps back for a frame.
    setLive(commitRef.current(w) ? w : null);
  }
  // Once the setting reflects the drag (or anything else changes it), the setting draws the pane again.
  useEffect(() => { if (!dragging) setLive(null); }, [fraction]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { const d = doc(); if (d) { d.body.style.cursor = ""; d.body.style.userSelect = ""; } }, []);

  const setTo = (w: number) => { const next = clamp(w); state.current.width = next; setLive(commitRef.current(next) ? next : null); };
  const step = (dir: 1 | -1, big: boolean) => setTo(state.current.width + dir * (big ? BIG_STEP : STEP) * state.current.total);
  const reset = () => { setLive(null); if (fraction !== undefined && fraction !== defaultFraction) onCommit(defaultFraction); };
  const onKeyDown = (e: { key: string; shiftKey?: boolean; preventDefault(): void }) => {
    // The pane is on the right: Left widens it, Right narrows it. Home is its narrowest, End its widest, Enter resets.
    if (e.key === "ArrowLeft") step(1, !!e.shiftKey);
    else if (e.key === "ArrowRight") step(-1, !!e.shiftKey);
    else if (e.key === "Home") setTo(minOf());
    else if (e.key === "End") setTo(maxOf());
    else if (e.key === "Enter") reset();
    else return;
    e.preventDefault();
    // A key on the handle is keyboard use, even when a click focused it: show the ring.
    setFocus(true);
  };

  // Too narrow for both minimums: the divider has nowhere to go, so it is a plain border with no handle.
  const fixed = total > 0 && maxW - minW < 2;
  // Dragging into a bound eases the grip back to its hover weight: the pane stopped, the drag didn't break.
  const atBound = dragging && (width <= minW || width >= maxW);
  // Keyboard focus keeps the line at hover weight; the accent ring on the grip carries it.
  const lineColor = dragging ? withAlpha(c.foreground, 0.7) : hover || focus ? withAlpha(c.foreground, 0.28) : c.border;
  const lineWidth = dragging || hover || focus ? 2 : 1;
  const grip = atBound ? withAlpha(c.foreground, 0.4) : dragging || focus ? c.foreground : hover ? withAlpha(c.foreground, 0.4) : "transparent";
  const percent = total ? Math.round((width / total) * 100) : Math.round(chosen * 100);
  const web = Platform.OS === "web";
  const a11y = web
    ? { role: "separator", "aria-orientation": "vertical", "aria-label": label, "aria-valuenow": percent, "aria-valuemin": total ? Math.round((minW / total) * 100) : 0, "aria-valuemax": total ? Math.round((maxW / total) * 100) : 100,
      "aria-valuetext": `${percent}% of the width`, tabIndex: 0, onKeyDown, onFocus: (e: { target?: { matches?(selector: string): boolean } }) => setFocus(!!e.target?.matches?.(":focus-visible")), onBlur: () => setFocus(false),
      onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false), onDoubleClick: reset, title: "Drag to resize · ← → move it · Enter or double-click resets" }
    : { accessible: true, accessibilityRole: "adjustable", accessibilityLabel: label, accessibilityValue: { text: `${percent}% of the width` },
      accessibilityActions: [{ name: "increment" }, { name: "decrement" }, { name: "activate", label: "Reset" }],
      onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => { const n = e.nativeEvent.actionName; if (n === "increment") step(1, false); else if (n === "decrement") step(-1, false); else if (n === "activate") reset(); } };

  return <View testID={testID} onLayout={(e: LayoutChangeEvent) => setTotal(e.nativeEvent.layout.width)} style={{ flex: 1, flexDirection: "row", minWidth: 0 }}>
    <View style={{ flex: 1, minWidth: 0 }}>{main}</View>
    {/* The divider: a 1px border at rest; the hit area is wider than the line and sits on top of both edges. */}
    <View style={{ width: 0, zIndex: 3 }}>
      {/* A 2px line straddles the column (-1..+1); the hit area is centred on it, so the line sits in its middle. */}
      <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: lineWidth === 2 ? -1 : 0, width: lineWidth, backgroundColor: fixed ? c.border : lineColor }} />
      {!fixed && <>
      <View pointerEvents="none" style={{ position: "absolute", top: "50%", left: -2, marginTop: -16, width: 5, height: 32, borderRadius: 3, backgroundColor: grip,
        ...(web && focus ? { outlineStyle: "solid", outlineWidth: 2, outlineColor: c.accent, outlineOffset: 2 } as object : null) }} />
      <View {...responder.panHandlers} {...(a11y as object)} testID={testID ? `${testID}-handle` : undefined}
        style={{ position: "absolute", top: 0, bottom: 0, left: -Math.floor(HIT / 2), width: HIT, ...(web ? { cursor: "col-resize", outlineStyle: "none" } as object : null) }} />
      </>}
    </View>
    <View testID={testID ? `${testID}-side` : undefined} style={{ width, minWidth: 0 }}>{side}</View>
  </View>;
}
