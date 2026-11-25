import { useEffect } from "react";
import { Platform } from "react-native";
import { overlayOver, surfaceVisible } from "../shared/list-keys";
import { OVERLAYS } from "./list-keys";
import { createSearchFocus, type SearchFocus } from "../shared/search-focus";

/**
 * The web side of every-search-request-lands-in-the-visible-search (shared/search-focus.ts). A request is held until
 * the developer acts: a key, a pointer, a click (voice control and a screen reader's activate send a click with no
 * pointer), a wheel or typed input, heard on the window in the capture phase so it runs before the request's own key
 * handler (that key makes the request after this runs). While it holds, focus moving without the developer tries again
 * (`focusMoved`), except on a touch screen, where a focus() nobody tapped for would pop the keyboard up unasked. Native
 * hears none of those events, so there the request ends with the first field that mounts or lays out after it.
 */
type Listen = (type: string, listener: (e: { target?: unknown }) => void, capture?: boolean) => void;
type Doc = { activeElement?: unknown; visibilityState?: string; querySelectorAll?(selector: string): Iterable<unknown> };
type Win = { addEventListener?: Listen; removeEventListener?: Listen; document?: Doc; matchMedia?(q: string): { matches: boolean } };
type El = { closest?(selector: string): unknown };

/** Where focus went: into a dialog or menu (the request waits for it), or onto a Home search. */
const DIALOG = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"]';
export const SEARCH_FIELD_ATTR = "data-follow-up-search";
const CANCEL_EVENTS = ["keydown", "pointerdown", "click", "wheel", "touchstart", "input"] as const;

export function createWebSearchFocus(): SearchFocus & { install(): () => void } {
  const focus = createSearchFocus();
  const win = globalThis as Win;
  const web = Platform.OS === "web" && typeof win.addEventListener === "function";
  // Native: the first field that mounts or lays out after a request ends it, whether it took the caret or not.
  const native = <T,>(out: T) => { if (!web) focus.cancel(); return out; };
  return {
    ...focus,
    request: () => { const took = focus.request(); if (took) native(0); return took; },
    changed: () => native(focus.changed()),
    register: field => native(focus.register(field)),
    install() {
      if (!web) return () => undefined;
      const cancel = () => focus.cancel();
      const coarse = !!win.matchMedia?.("(pointer: coarse)").matches;
      const moved = (e: { target?: unknown }) => {
        if (!focus.wanted()) return;
        if (coarse) { focus.cancel(); return; }
        const el = e.target as El | null;
        focus.focusMoved({ dialog: !!el?.closest?.(DIALOG), search: !!el?.closest?.(`[${SEARCH_FIELD_ATTR}]`) });
      };
      for (const t of CANCEL_EVENTS) win.addEventListener!(t, cancel, true);
      win.addEventListener!("focusin", moved, true);
      return () => { for (const t of CANCEL_EVENTS) win.removeEventListener?.(t, cancel, true); win.removeEventListener?.("focusin", moved, true); };
    },
  };
}

type Input = { focus(): void; select?(): void; checkVisibility?(): boolean; getClientRects?(): { length: number } };

/**
 * Registers Home's search field with the one owner of search focus while it is mounted. Shown means laid out on the
 * visible page (`surfaceVisible`): a Home Paseo keeps mounted behind another screen never takes the caret. Covered: a
 * menu or modal dialog is drawn over it (`overlayOver`), so the request waits instead of fighting the dialog. Landing
 * selects the query, so typing replaces it, as in a command palette. Returns the field's onLayout, which tries a
 * waiting request again when the field comes on screen. The field carries SEARCH_FIELD_ATTR (QueryField's `dataSet`).
 */
export function useSearchFocusField(owner: SearchFocus, ref: { current: unknown }): () => void {
  useEffect(() => {
    const doc = (globalThis as Win).document;
    const web = Platform.OS === "web" && !!doc;
    return owner.register({
      shown: () => { const el = ref.current as Input | null; return !!el && (!web || surfaceVisible(el, doc!)); },
      covered: () => web && overlayOver((doc!.querySelectorAll?.(OVERLAYS) ?? []) as never, ref.current),
      focused: () => web ? !!ref.current && doc!.activeElement === ref.current : !!(ref.current as { isFocused?(): boolean } | null)?.isFocused?.(),
      focus: () => { const el = ref.current as Input | null; el?.focus(); if (web) el?.select?.(); },
    });
  }, [owner, ref]);
  return () => { if (owner.wanted()) owner.changed(); };
}

/**
 * The one way to ask for Home's search (the search key and ⌘K "Follow-up: Search"): the request is held by the
 * owner, and Home's list opens unless a Home search is already on screen. The route alone never decides: Catch up, PR
 * stats, the queue and the log share Home's route, and on a phone Home's route can show a row's detail, none of them
 * with the search drawn. Whichever search field then comes on screen takes the caret.
 */
export function requestSearch(owner: SearchFocus, open: () => void): void {
  owner.request();
  if (!owner.shown()) open();
}
