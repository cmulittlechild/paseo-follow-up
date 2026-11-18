import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import * as pluginClient from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Text } from "./text";
import { text, type Theme } from "./kit";
import { PressScale, Spinner } from "./motion";
import { withAlpha } from "./theme";
import { hostDictationHook, insertDictated, micView, type UseHostDictation } from "../shared/dictation";

/** Paseo's dictation hook when this host has one (read per render, so a test host can add or remove it). */
export const hostDictation = (): UseHostDictation | null => hostDictationHook(pluginClient);

/** The caret of a field, for inserting dictated words where the developer was writing. */
export function useCaret() {
  const sel = useRef<{ start: number; end: number } | null>(null);
  return {
    selection: () => sel.current,
    onSelectionChange: (e: { nativeEvent: { selection: { start: number; end: number } } }) => { sel.current = e.nativeEvent.selection; },
    insert: (words: string, said: string, maxLength?: number) => {
      const next = insertDictated(words, said, sel.current, maxLength);
      sel.current = { start: next.caret, end: next.caret };
      return next.words;
    },
  };
}

/** Room the field leaves for the mic in its bottom-right corner. */
const MIC = { desktop: 32, phone: 36 } as const;
export type FieldPad = { paddingRight: number; minHeight?: number } | null;

/**
 * A text field with Paseo's dictation inside it (dictated-text-lands-in-the-field). The mic sits in the field's
 * bottom-right corner, where the words are being written, never on its own; tap to start, tap to stop, and the words
 * land through `onText` in the field's own state, editable, never sent. `field(pad)` draws the field: `pad` is the
 * room to leave for the mic, or null on a Paseo without usePaseoDictation, which renders the field alone, unchanged.
 * One component, so any answer field (Catch up today; Home and the panel later) takes the same mic.
 */
export function DictationField({ theme, compact, field, onText, disabled = false, keyHint = false }: {
  theme: Theme; compact: boolean; field: (pad: FieldPad) => ReactNode; onText: (text: string) => void; disabled?: boolean;
  /** Desktop Catch up: the button and its line name the key (V). */ keyHint?: boolean;
}) {
  const use = hostDictation();
  return use ? <Mic use={use} theme={theme} compact={compact} field={field} onText={onText} disabled={disabled} keyHint={keyHint} /> : <>{field(null)}</>;
}

function Mic({ use, theme, compact, field, onText, disabled, keyHint }: {
  use: UseHostDictation; theme: Theme; compact: boolean; field: (pad: FieldPad) => ReactNode; onText: (text: string) => void; disabled: boolean; keyHint: boolean;
}) {
  const c = theme.colors; const t = text(c, compact);
  const latest = useRef(onText); latest.current = onText;
  const d = use({ onText: said => latest.current(said) });
  const [explain, setExplain] = useState(false);
  useEffect(() => { if (!d.unavailable) setExplain(false); }, [!!d.unavailable]);
  // Leaving the card mid-recording discards it: nothing is written into a field that's gone.
  const cancel = useRef(d.cancel); cancel.current = d.cancel;
  useEffect(() => () => { void cancel.current().catch(() => undefined); }, []);
  const view = micView(d, { explain, key: keyHint && !compact });
  const press = () => {
    if (view.state === "unavailable") { setExplain(v => !v); return; }
    if (view.state === "listening") { void d.stop().catch(() => undefined); return; }
    if (view.state === "idle") void d.start().catch(() => undefined);
  };
  const live = view.state === "listening";
  // Red is recording (the dot, the Stop button) and failure; the listening words stay neutral.
  const lineColor = view.tone === "live" ? c.foreground : view.tone === "danger" ? c.statusDanger : c.foregroundMuted;
  const size = compact ? MIC.phone : MIC.desktop;
  // The desktop hover title names the key; React Native Web drops `title` on a Pressable, so it goes on a wrapper.
  const tip = useRef<View | null>(null);
  useEffect(() => { if (Platform.OS === "web" && !compact) (tip.current as unknown as { setAttribute?: (k: string, v: string) => void } | null)?.setAttribute?.("title", view.label); }, [view.label, compact]);
  const inactive = disabled || view.disabled;
  const button = <View ref={tip} {...({ dataSet: { dictate: "1" } } as object)} style={{ position: "absolute", right: 6, bottom: 6 }}>
    <PressScale accessibilityRole="button" accessibilityLabel={view.label} accessibilityState={{ disabled: inactive, busy: view.state === "transcribing" }} disabled={inactive} onPress={press}
      hitSlop={compact ? (44 - size) / 2 : 4}
      style={({ pressed, hovered }) => ({ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center",
        backgroundColor: live ? (pressed ? withAlpha(c.statusDanger, 0.85) : c.statusDanger) : pressed ? c.surface2 : hovered ? c.surface2 : "transparent",
        opacity: inactive && view.state !== "transcribing" ? 0.45 : 1 })}>
      {view.state === "transcribing" ? <Spinner color={c.foregroundMuted} size={14} label={view.label} />
        : live ? <View style={{ width: compact ? 12 : 10, height: compact ? 12 : 10, borderRadius: 2, backgroundColor: "#ffffff" }} />
        : <Icon name={view.icon} size={compact ? 18 : 16} color={view.state === "unavailable" ? c.foregroundMuted : c.foreground} />}
    </PressScale>
  </View>;
  return <View style={{ gap: 6 }}>
    <View style={{ position: "relative" }}>
      {field({ paddingRight: size + 12, ...(compact ? { minHeight: size + 12 } : {}) })}
      {button}
    </View>
    {view.line && <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 18 }}>
      {live ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.statusDanger, opacity: 0.75 + 0.25 * Math.min(1, Math.max(0, d.volume) * 3) }} />
        : view.state === "transcribing" ? null
        : <Icon name={view.state === "unavailable" ? "MicOff" : "CircleAlert"} size={12} color={lineColor} />}
      <Text style={[t.meta, { color: lineColor, flexShrink: 1 }]}>{view.line}</Text>
    </View>}
  </View>;
}
