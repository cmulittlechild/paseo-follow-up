import { summary } from "./model";
import type { ListWorkspace } from "./list";

/**
 * Follow-up's badges on Paseo's sidebar workspace rows (Paseo 0.17.1+, `addWorkspaceRowBadgeItem`). One item per
 * signal the developer would switch off on its own in the sidebar's Show menu; today that's Done, which replaced the
 * emerald "Done" workspace label the worker used to write (invariant row-badges-replace-sidebar-labels).
 */
export type RowBadgeTone = "muted" | "success" | "warning" | "danger" | "info";
export type RowBadge = { icon: string; label: string; tone: RowBadgeTone; accessibilityLabel: string };

/** The Show menu's id, title and icon for the Done badge. */
export const DONE_BADGE = { id: "done", title: "Follow-up: Done", icon: "CircleCheck" } as const;

/**
 * Done on the row when Home shows the workspace as Done (`summary` says "done": declared, nothing blocking, nothing
 * waiting on the developer), with Home's icon and tone for that row. Null otherwise, and for workspaces Follow-up
 * doesn't follow.
 */
export function doneBadge(w: ListWorkspace | undefined, now: number): RowBadge | null {
  if (!w || !w.enable_tracking || w.archived) return null;
  if (summary(w, now).status !== "done") return null;
  return { icon: DONE_BADGE.icon, label: "Done", tone: "success", accessibilityLabel: "Follow-up: Done" };
}
