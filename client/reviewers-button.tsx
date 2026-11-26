import { tr } from "./i18n-text";
import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { requestReviewersRpc } from "../shared/contracts";
import { workspaceKey } from "./keys";
import { reviewersScope, reviewersWords, type ReviewersOutcome } from "../shared/reviewers-click";
import type { ListWorkspace as Workspace } from "../shared/list";
import type { NeedItem } from "../shared/attention";
import { keepInPlace } from "../shared/keep-in-place";
import { Button, errorText, text, type ButtonKind, type Theme } from "./kit";
import { Text } from "./text";
import { View } from "react-native";

type Control = { button: ReactNode; notice: ReactNode; /** Asked: the row reads as a receipt, not an ask. */ done: boolean };

/**
 * Each PR's click, for the session: in flight, or what came of it. One store for every surface (the panel's block and
 * its rows, the chat's brief card, Home's detail pane, the pill), keyed by workspace and PR, so a click on one shows on
 * all, and a surface that regroups its rows (the block folds a brief into a row) never loses it. Memory only.
 */
type Entry = { running: boolean; outcome: ReviewersOutcome | null };
let asked: Record<string, Entry> = {};
const subscribers = new Set<() => void>();
const keyOf = (workspaceId: string, prKey: string) => `${workspaceId}|${prKey}`;
const setEntry = (k: string, e: Entry) => { asked = { ...asked, [k]: e }; for (const f of subscribers) f(); };
const subscribe = (f: () => void) => { subscribers.add(f); return () => { subscribers.delete(f); }; };
const snapshot = () => asked;
/** One PR's click as the session holds it, for a list deciding how to draw and count a held row. */
export const reviewerClick = (workspaceId: string, prKey: string): Entry | undefined => asked[keyOf(workspaceId, prKey)];
/** Tests: forget every click. */
export const resetReviewerClicks = () => { asked = {}; for (const f of subscribers) f(); };

/**
 * a-clicked-row-holds-its-place: the Needs-you items a surface draws, with every reviewers row clicked here kept where
 * it was after the next read drops it, until the surface unmounts. Call it on the items before anything groups them
 * (the block's cards and rows), so the grouping never changes under the developer's next click either.
 */
export function useHeldNeeds(workspaceId: string, items: readonly NeedItem[]): NeedItem[] {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  const drawn = useRef<readonly NeedItem[]>([]);
  const out = keepInPlace(drawn.current, items, i => i.key, key => key.startsWith("reviewers:") && !!all[keyOf(workspaceId, key.slice("reviewers:".length))]);
  drawn.current = out;
  return out;
}

/**
 * Every Add reviewers button that names its people (a Needs-you row, Catch up's card, a brief's move): one click asks
 * the saved reviewers the row names, with no sheet (a-click-on-add-reviewers-asks, shared/reviewers-click.ts). Each
 * PR has its own pending and outcome, so clicks on several rows one after another all run, and none waits on or
 * disables another (no shared busy lock: a single `useMutation` tracks only its latest call). `fallback` opens the
 * PR sheet's picker, only when nobody is set for the PR. `held(prKey)` says a row has a local outcome to keep
 * showing, so the list keeps it in place (keep-in-place.ts).
 */
export type ReviewerButtons = ((prKey: string, o: { theme: Theme; compact: boolean; kind?: ButtonKind; fallback?: () => void; after?: () => void }) => Control | null) & {
  held: (prKey: string) => boolean;
  /** For a surface with its own buttons (the brief card): label and one-click run. Null: nobody set, or the PR isn't tracked. */
  view: (prKey: string, after?: () => void) => { label: string; a11y: string; running: boolean; done: boolean; why: string | null; run: () => void } | null;
};

export function useReviewerButtons(w: Pick<Workspace, "id" | "prs"> | undefined): ReviewerButtons {
  const request = useRpc(requestReviewersRpc);
  const cache = useQueryClient();
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  const entry = (prKey: string) => w ? all[keyOf(w.id, prKey)] : undefined;
  const refresh = () => w ? Promise.all([
    cache.invalidateQueries({ queryKey: workspaceKey(w.id) }),
    ...[["follow-up", "pr-controls", w.id], ["follow-up", "overview"]].map(key => cache.invalidateQueries({ queryKey: key })),
  ]).catch(() => undefined) : Promise.resolve();

  const run = (prKey: string, after?: () => void) => {
    if (!w) return;
    // Read the store, not this render's copy, so a double click never sends twice.
    const k = keyOf(w.id, prKey); const now = asked[k];
    if (now?.running || now?.outcome?.state === "submitted" || now?.outcome?.state === "uncertain") return;
    setEntry(k, { running: true, outcome: null });
    // No reviewers argument: the server asks the saved list, the same people the row names.
    void request({ workspaceId: w.id, prKey })
      .then(reply => ({ state: reply.state, result: reply.result }) as ReviewersOutcome, (e: unknown) => ({ state: "error", result: errorText(e) }) as ReviewersOutcome)
      .then(outcome => {
        setEntry(k, { running: false, outcome });
        void refresh();
        if (outcome.state === "submitted") after?.();
      });
  };

  const stateOf = (prKey: string, compact = false) => {
    const pr = w?.prs.find(p => p.key === prKey);
    const scope = pr ? reviewersScope(pr) : null;
    if (!scope) return null;
    const e = entry(prKey);
    const words = reviewersWords(scope, e?.outcome ?? null, !!e?.running, compact);
    return { scope, words, running: !!e?.running };
  };

  const control = (prKey: string, { theme, compact, kind = "secondary", fallback, after }: Parameters<ReviewerButtons>[1]): Control | null => {
    const c = theme.colors; const t = text(c, compact);
    const s = stateOf(prKey, compact);
    if (!s) return fallback ? { done: false, notice: null, button: <Button theme={theme} compact={compact} kind={kind} icon="UserPlus" title={tr("Add reviewers…")} accessibilityLabel={tr("Pick reviewers for this PR")} onPress={fallback} /> } : null;
    const { scope, words } = s;
    // As wide as its widest word, so the PR link beside it never moves under the next click.
    const button = <View style={{ minWidth: compact ? 118 : 146 }}><Button theme={theme} compact={compact} kind={kind} icon={words.done ? tr("Check") : "UserPlus"} title={words.button}
      accessibilityLabel={words.done && words.button !== "Unconfirmed" ? scope.doneA11y : words.done ? `Unconfirmed: ${scope.a11y}` : scope.a11y}
      loading={s.running} disabled={s.running || words.done} onPress={() => run(prKey, after)} /></View>;
    const notice = words.line ? <Text accessibilityRole={words.tone === "warning" ? "alert" : undefined} style={[t.meta, words.tone === "warning" ? { color: c.statusWarning } : null]}>{words.line}</Text> : null;
    return { button, notice, done: words.done };
  };
  const held = (prKey: string) => !!entry(prKey);
  const view: ReviewerButtons["view"] = (prKey, after) => {
    const s = stateOf(prKey);
    if (!s) return null;
    return { label: s.words.button, a11y: s.scope.a11y, running: s.running, done: s.words.done, why: s.words.tone === "warning" ? s.words.line : null, run: () => run(prKey, after) };
  };
  return Object.assign(control, { held, view });
}
