import { builtinAction, type DispatchAction } from "./dispatch";
import { actionIcon } from "./new-view";

/**
 * Settings → New work (client/new-settings.tsx): what each row says, kept pure so the screen and its tests agree.
 * Every change goes through the RPCs the agent tools run (set_dispatch_actions, set_dispatch_settings).
 */

export type ActionRowModel = {
  id: string;
  name: string;
  description: string;
  icon: string;
  hidden: boolean;
  /** "↵" / "⌥↵": the first two shown for an issue, the keys New gives them. */
  key: "↵" | "⌥↵" | null;
  /** Where it shows besides issues, links and words: "PRs only" or "Issues and PRs". */
  scope: string | null;
  /** "Edited", "Added by an agent", "Added": null for an untouched built-in. */
  origin: string | null;
  canReset: boolean;
  canDelete: boolean;
  first: boolean;
  last: boolean;
};

/** A built-in whose saved copy differs from the shipped one in anything but Show/Hide. */
export function isEdited(a: DispatchAction): boolean {
  if (!a.builtin) return false;
  const { hidden: _h, by: _b, ...mine } = a;
  const { hidden: _h2, by: _b2, ...shipped } = builtinAction(a.builtin);
  return JSON.stringify(mine) !== JSON.stringify({ ...shipped, builtin: a.builtin });
}

export function actionRows(actions: readonly DispatchAction[]): ActionRowModel[] {
  // The keys follow New's own order: the first two shown for an issue.
  const issueShown = actions.filter(a => !a.hidden && a.appliesTo.includes("issue")).map(a => a.id);
  return actions.map((a, i) => ({
    id: a.id, name: a.name, description: a.description, icon: actionIcon(a.icon), hidden: a.hidden,
    key: issueShown[0] === a.id ? "↵" : issueShown[1] === a.id ? "⌥↵" : null,
    scope: a.appliesTo.includes("pr") ? a.appliesTo.includes("issue") ? "Issues and PRs" : "PRs only" : null,
    origin: a.builtin ? isEdited(a) ? "Edited" : null : a.by?.startsWith("agent:") ? "Added by an agent" : "Added",
    canReset: !!a.builtin && isEdited(a), canDelete: !a.builtin,
    first: i === 0, last: i === actions.length - 1,
  }));
}

export type SettingsView = {
  rules: { team: string; projectId: string; project: string | null }[];
  bases: { projectId: string; project: string | null; base: string }[];
  noTeam: "last" | "ask";
  lastProjectId: string | null;
  learned: Record<string, Record<string, number>>;
  projects: { id: string; name: string; repo: string | null; worktree: boolean }[];
};

/** Teams whose past work points at one project but have no rule: "Make it a rule" offers each. */
export function learnedTeams(view: SettingsView, minCount = 2): { team: string; projectId: string; project: string; count: number }[] {
  const ruled = new Set(view.rules.map(r => r.team));
  return Object.entries(view.learned).flatMap(([team, counts]) => {
    if (ruled.has(team)) return [];
    const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const project = top && view.projects.find(p => p.id === top[0]);
    return top && project && top[1] >= minCount ? [{ team, projectId: top[0], project: project.name, count: top[1] }] : [];
  }).sort((a, b) => b.count - a.count || a.team.localeCompare(b.team));
}

/** A team key as New stores it: Linear's upper-case prefix, letters and digits. */
export const teamKey = (raw: string) => raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 30);

/** The category's one line: "5 actions shown · 2 team rules · 1 base". */
export function newWorkSummary(actions: readonly DispatchAction[] | null, view: SettingsView | null): string | null {
  if (!actions && !view) return null;
  const parts: string[] = [];
  if (actions) parts.push(`${actions.filter(a => !a.hidden).length} action${actions.filter(a => !a.hidden).length === 1 ? "" : "s"} shown`);
  if (view) {
    parts.push(view.rules.length ? `${view.rules.length} team rule${view.rules.length === 1 ? "" : "s"}` : "No team rules");
    if (view.bases.length) parts.push(`${view.bases.length} base${view.bases.length === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}
