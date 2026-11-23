/**
 * Walking a list of rows from the keyboard (desktop and web), the keys and the step. Home and Paseo's sidebar view
 * walk HomeList with these through one hook (client/list-keys.ts; invariant one-keyboard-walk-for-every-list).
 */
export type ListMove = "next" | "prev" | "first" | "last" | "open" | "keys";
export type ListKeyEvent = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

/**
 * Which move a key is. Modified keys stay Paseo's: ⌘[ ⌘] and ⌘1…9 (Ctrl, or Alt on the web) walk its own sidebar.
 * Escape (Paseo's interrupt) and Space (its voice toggle) are never ours. In the list's own query field only the
 * arrows count, so j, k, Home, End and Enter still type there.
 */
export function listMove(e: ListKeyEvent, typing: boolean): ListMove | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "ArrowDown") return "next";
  if (e.key === "ArrowUp") return "prev";
  if (typing || e.shiftKey) return null;
  switch (e.key) {
    case "j": return "next";
    case "k": return "prev";
    case "Home": return "first";
    case "End": return "last";
    case "Enter": case "o": return "open";
    // Catch up's letter for the keys sheet: the same letter does the same thing on Home.
    case "s": return "keys";
    default: return null;
  }
}

/**
 * The row Enter (or O) opens (invariant the-selected-workspace-opens-with-enter). A focused row opens itself. On Home
 * ("select") the selection opens too when nothing has focus: after a click, a ⌘K or search pick, or coming back to
 * Home the selection is on screen but focus is on the page, not on its row. Enter on any other control (a button, a
 * chip, a field) stays that control's: the caller never asks then.
 */
export function enterTarget(input: { focused: string | null; selectedKey: string | null; mode: "select" | "focus"; onBody: boolean }): string | null {
  if (input.focused) return input.focused;
  return input.mode === "select" && input.onBody ? input.selectedKey : null;
}

/**
 * Enter in Home's search: the first press picks the active result (the detail pane shows it); a press on the result
 * that is already selected opens it, as Enter on its row would. With no query, Enter opens the selection.
 */
export function searchEnter(input: { item: string | null; selected: string | null; query: string }): "select" | "open" | null {
  if (!input.query.trim()) return input.selected ? "open" : null;
  if (!input.item) return null;
  return input.item === input.selected ? "open" : "select";
}

/** The row a move lands on: one step, clamped at both ends (no wrap). From no row (or one that left), the first. */
export function stepKey(order: readonly string[], current: string | null, move: Exclude<ListMove, "open" | "keys">): string | null {
  if (!order.length) return null;
  if (move === "last") return order[order.length - 1];
  const i = current === null ? -1 : order.indexOf(current);
  if (move === "first" || i < 0) return order[0];
  return order[Math.max(0, Math.min(order.length - 1, i + (move === "next" ? 1 : -1)))];
}

/**
 * The walk's order: the rows a list draws, in order (shared/list-entries.ts), so the brief and the Overseer come first
 * and a collapsed group, a closed Quiet fold or a filtered-out row is never a stop. A search walks its results instead.
 */
export function walkOrder(entries: readonly { type: string; key: string }[]): string[] {
  return entries.filter(e => e.type === "brief" || e.type === "overseer" || e.type === "row").map(e => e.key);
}

/**
 * Whether a key belongs to this surface: focus inside it, or (Home) nothing focused while Home is on screen. Home and
 * the sidebar view sit side by side, so focus in one never moves the other; and a Home kept mounted behind another tab
 * or chat never takes a body key, which there scrolls the chat in front.
 */
export function ownsKey(input: { inside: boolean; onBody: boolean; claimBody: boolean; visible: boolean; overlayOpen?: boolean }): boolean {
  // An open menu or dialog owns every key, wherever focus is: while it swaps a step (the row menu's confirm), focus
  // sits on the page for a frame, and Enter there must not open the selection behind it.
  if (input.overlayOpen) return false;
  return input.inside || input.claimBody && input.onBody && input.visible;
}

type Visible = { checkVisibility?(): boolean; getClientRects?(): { length: number } };

/**
 * Whether a surface is on screen: its page is the visible one and its root is laid out (not display:none, nor inside a
 * hidden ancestor). `checkVisibility` where the engine has it, else laid-out boxes. No root yet: not visible.
 */
export function surfaceVisible(root: Visible | null | undefined, doc: { visibilityState?: string }): boolean {
  if (!root) return false;
  if (doc.visibilityState !== undefined && doc.visibilityState !== "visible") return false;
  if (typeof root.checkVisibility === "function") return root.checkVisibility();
  return (root.getClientRects?.().length ?? 0) > 0;
}

/**
 * Where a move lands. From the list's own query field the arrows enter the list: at the selection on Home ("select"),
 * at the first match in the sidebar view ("focus"). Otherwise one step from the focused row, or from the selection.
 */
export function walkTarget(input: { order: readonly string[]; focused: string | null; selectedKey: string | null; mode: "select" | "focus"; typing: boolean; move: Exclude<ListMove, "open" | "keys"> }): string | null {
  const { order, focused, selectedKey, mode, typing, move } = input;
  const from = focused ?? (selectedKey !== null && order.includes(selectedKey) ? selectedKey : null);
  if (typing) return mode === "select" && from ? from : order[0] ?? null;
  return stepKey(order, from, move);
}
