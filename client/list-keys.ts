import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { enterTarget, listMove, ownsKey, surfaceVisible, walkTarget } from "../shared/list-keys";
import { rowDomId } from "./kit";

type Row = { focus(o?: { preventScroll?: boolean }): void; scrollIntoView?(o?: { block?: string }): void };
type Node = { contains(other: unknown): boolean; querySelector?(selector: string): Row | null; checkVisibility?(): boolean; getClientRects?(): { length: number } };
type Target = { tagName?: string; isContentEditable?: boolean; id?: string; closest?(selector: string): unknown } | null;
type DomKey = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; target: unknown; preventDefault(): void; stopPropagation(): void };
type Doc = { body: unknown; activeElement: unknown; visibilityState?: string; querySelector(selector: string): Row | null;
  addEventListener(t: string, f: (e: DomKey) => void, capture?: boolean): void; removeEventListener(t: string, f: (e: DomKey) => void, capture?: boolean): void };

export type ListKeysOptions = {
  enabled: boolean;
  /** The rows in the order the list draws them (brief, Overseer, then every row of an open group). */
  order: readonly string[];
  /**
   * "select": the selection follows the keys (Home: its detail pane follows). "focus": only the focus moves, and Enter
   * opens the row (the sidebar view: opening loads a chat and moves the main pane, so it waits for Enter).
   */
  mode: "select" | "focus";
  selectedKey: string | null;
  /** The surface the keys belong to: they act only while focus is inside it. */
  scope: () => Node | null;
  /**
   * Keys pressed with nothing focused (the page body) are this surface's too: Home, the main screen. Only while its
   * root is on screen: a Home kept mounted behind another tab or chat leaves body keys to what's in front.
   */
  claimBody?: boolean;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
  /** S: show this surface's keys (Home's keys sheet). Without it S stays unclaimed. */
  onKeys?: () => void;
  /** A row the virtualized list hasn't drawn yet: scroll it in, so it can take focus. */
  reveal: (key: string) => void;
};

/**
 * The one keyboard walk for a list of rows (invariant one-keyboard-walk-for-every-list): ↑/↓ and j/k step, Home/End
 * jump, Enter opens. The focus moves with the keys, so the row's focus ring marks it and the browser keeps it in view.
 * Not while typing, except the arrows in the list's own query field (`dataSet={{ listKeys: "1" }}`), which step into
 * the list. Web and desktop only; phones have no hardware-key walk.
 */
export function useListKeys(options: ListKeysOptions): void {
  const ref = useRef(options); ref.current = options;
  useEffect(() => {
    const doc = (globalThis as { document?: Doc }).document;
    if (!options.enabled || Platform.OS !== "web" || !doc) return;
    const onKey = (e: DomKey) => {
      const { order, mode, selectedKey, scope, claimBody, onSelect, onOpen, onKeys, reveal } = ref.current;
      const target = e.target as Target;
      const typing = !!target && (!!target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName ?? ""));
      if (typing && !target?.closest?.("[data-list-keys]")) return;
      // A row menu or a dialog over the list keeps its own keys, and so does a control whose keys move it (Home's
      // divider: arrows, Home and End resize the pane, never walk the list).
      if (target?.closest?.('[role="menu"],[role="dialog"],[aria-modal="true"],[role="separator"],[role="slider"]')) return;
      const root = scope();
      const onBody = !target || target === doc.body;
      if (!ownsKey({ inside: !!target && !!root?.contains(target), onBody, claimBody: !!claimBody,
        visible: !!claimBody && surfaceVisible(root, doc) })) return;
      const move = listMove(e, typing);
      if (!move) return;
      const focused = !typing && target?.id ? order.find(k => rowDomId(k) === target.id) ?? null : null;
      if (move === "keys") {
        if (!onKeys || typing) return;
        e.preventDefault(); e.stopPropagation(); onKeys();
        return;
      }
      if (move === "open") {
        // A focused row opens itself; on Home, with nothing focused, the selection does (a click, a search or ⌘K pick,
        // coming back). Enter on a header, a chip or a button keeps doing what that control does.
        const open = enterTarget({ focused, selectedKey, mode, onBody });
        if (!open) return;
        e.preventDefault(); e.stopPropagation(); onOpen(open);
        // The sidebar view: if opening the chat left focus nowhere, give it back to the row, so ↓ ↓ Enter keeps
        // walking. If Paseo put it somewhere (the composer), it stays there: never taken back.
        if (mode === "focus") keepWalking(doc, scope() ?? doc, open, reveal);
        return;
      }
      const to = walkTarget({ order, focused, selectedKey, mode, typing, move });
      if (!to) return;
      e.preventDefault(); e.stopPropagation();
      if (mode === "select" && to !== selectedKey) onSelect(to);
      focusRow(scope() ?? doc, to, reveal);
    };
    doc.addEventListener("keydown", onKey, true);
    return () => doc.removeEventListener("keydown", onKey, true);
  }, [options.enabled]);
}

/**
 * Focus a row inside this surface: Home and the sidebar view draw the same rows (the same ids) side by side, so the
 * lookup never leaves the surface's own root.
 */
function keepWalking(doc: Doc, root: Pick<Node, "querySelector">, key: string, reveal: (key: string) => void, waits = [300, 900, 1800]): void {
  const [wait, ...rest] = waits;
  if (wait === undefined) return;
  setTimeout(() => {
    const active = doc.activeElement;
    if (active && active !== doc.body) return;
    focusRow(root, key, reveal);
    keepWalking(doc, root, key, reveal, rest);
  }, wait);
}

function focusRow(root: Pick<Node, "querySelector">, key: string, reveal: (key: string) => void, tries = 10): void {
  const el = root.querySelector?.(`#${rowDomId(key)}`) ?? null;
  if (el) { el.focus({ preventScroll: true }); el.scrollIntoView?.({ block: "nearest" }); return; }
  if (tries === 10) reveal(key);
  if (tries > 0) requestAnimationFrame(() => focusRow(root, key, reveal, tries - 1));
}
