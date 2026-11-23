import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { Platform, View } from "react-native";
import { surfaceVisible } from "../shared/list-keys";

/**
 * One request shown by one of several mounted hosts (new-opens-where-you-are): New, Report an issue and Rename title
 * with AI. A dialog asks to open; every Follow-up surface that can draw it mounts a host; the host on screen shows it.
 * Paseo keeps a screen mounted behind another (Home opened again, a chat in front) as display:none, so "the first
 * mounted host" can be one the developer can't see: 2026-11-23 on Paseo 0.17.1, New landed on Home and nothing opened,
 * because the dialog was drawn in a Home hidden behind the one on screen.
 */

/**
 * Which host shows the request. The one showing it keeps it while it's on screen (a second host mounting never moves
 * an open dialog and what was typed in it); otherwise the most recently mounted host that's on screen. A hidden host
 * never does: null, and the request waits for one.
 */
export function pickHost(list: readonly { id: number; visible: boolean }[], keep: number | null): number | null {
  if (keep !== null && list.some(h => h.id === keep && h.visible)) return keep;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].visible) return list[i].id;
  return null;
}

/**
 * Whether a host's probe is on screen. Web: laid out and the page visible (`surfaceVisible`). Native has no DOM and
 * keeps no hidden screen to draw in, so a mounted host is on screen. No probe yet on web: not on screen.
 */
export function probeOnScreen(el: unknown): boolean {
  if (!el) return Platform.OS !== "web";
  const node = el as { checkVisibility?(): boolean; getClientRects?(): { length: number } };
  if (typeof node.checkVisibility !== "function" && typeof node.getClientRects !== "function") return true;
  return surfaceVisible(node, (globalThis as { document?: { visibilityState?: string } }).document ?? {});
}

/** How often an open request looks again for a host coming on screen or leaving it (only while open). */
export const HOST_LOOK_MS = 250;

export type HostSlot<R extends object> = ReturnType<typeof createHostSlot<R>>;

export function createHostSlot<R extends object>() {
  let current: (R & { token: number }) | null = null;
  let token = 0;
  const listeners = new Set<() => void>();
  let version = 0;
  const hosts: { id: number; visible: () => boolean }[] = [];
  let hostIds = 0;
  let owner: number | null = null;
  let fallback: ((r: R) => void) | null = null;
  let watch: ReturnType<typeof setInterval> | null = null;

  const pick = (keep: number | null) => pickHost(hosts.map(h => ({ id: h.id, visible: h.visible() })), keep);
  const notify = () => { version++; for (const l of listeners) l(); };
  const settle = () => {
    owner = current ? pick(owner) : null;
    // A host can come on screen or leave it without mounting (Paseo brings a kept screen forward): while a request is
    // open, look again a few times a second. Closed, nothing runs.
    if (current && !watch) {
      watch = setInterval(() => { const before = owner; settle(); if (owner !== before) notify(); }, HOST_LOOK_MS);
      (watch as { unref?: () => void }).unref?.();
    }
    if (!current && watch) { clearInterval(watch); watch = null; }
  };
  const emit = () => { settle(); notify(); };
  const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
  const snapshot = () => version;

  return {
    /**
     * Opens the request on the host on screen. With none on screen it is kept, and `navigate` (default: the fallback)
     * is asked to bring a surface that mounts one; the first host on screen then shows it. `navigate: null` never
     * navigates (a surface opened for this request, taking it on mount).
     */
    open(request: R, opts: { navigate?: ((r: R) => void) | null } = {}): void {
      current = { ...request, token: ++token };
      emit();
      if (owner === null) (opts.navigate === undefined ? fallback : opts.navigate)?.(request);
    },
    close(): void { current = null; emit(); },
    now: () => current,
    /** Whether any host is on screen now. */
    shown: () => pick(null) !== null,
    setFallback(open: ((r: R) => void) | null): void { fallback = open; },
    /** Whether a request is open (shown or waiting for a host). */
    useOpen(): boolean { useSyncExternalStore(subscribe, snapshot, snapshot); return !!current; },
    /**
     * A host: registers while mounted and returns the request when it's this host's to show (else null), plus the
     * probe to render (always, so the host can tell whether it's on screen).
     */
    useHost(): { request: (R & { token: number }) | null; probe: ReactElement } {
      const [id] = useState(() => ++hostIds);
      const ref = useRef<unknown>(null);
      useEffect(() => {
        hosts.push({ id, visible: () => probeOnScreen(ref.current) });
        emit();
        return () => { const i = hosts.findIndex(h => h.id === id); if (i >= 0) hosts.splice(i, 1); emit(); };
      }, [id]);
      useSyncExternalStore(subscribe, snapshot, snapshot);
      const probe = <View ref={ref as never} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: "absolute", width: 0, height: 0 }} />;
      return { request: current && owner === id ? current : null, probe };
    },
  };
}
