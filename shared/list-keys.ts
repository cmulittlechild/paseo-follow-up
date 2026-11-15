/**
 * Walking a list of rows from the keyboard (desktop and web), the keys and the step. Home and Paseo's sidebar view
 * walk HomeList with these through one hook (client/list-keys.ts; invariant one-keyboard-walk-for-every-list).
 */
export type ListMove = "next" | "prev" | "first" | "last" | "open";
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
    case "Enter": return "open";
    default: return null;
  }
}

/** The row a move lands on: one step, clamped at both ends (no wrap). From no row (or one that left), the first. */
export function stepKey(order: readonly string[], current: string | null, move: Exclude<ListMove, "open">): string | null {
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
export function ownsKey(input: { inside: boolean; onBody: boolean; claimBody: boolean; visible: boolean }): boolean {
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
export function walkTarget(input: { order: readonly string[]; focused: string | null; selectedKey: string | null; mode: "select" | "focus"; typing: boolean; move: Exclude<ListMove, "open"> }): string | null {
  const { order, focused, selectedKey, mode, typing, move } = input;
  const from = focused ?? (selectedKey !== null && order.includes(selectedKey) ? selectedKey : null);
  if (typing) return mode === "select" && from ? from : order[0] ?? null;
  return stepKey(order, from, move);
}
