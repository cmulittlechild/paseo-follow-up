import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { HomeModel } from "../shared/home";
import { filterHome, homeSearchDocs, indexDocs, search, type SearchHit } from "../shared/search";
import { listEntries, type ListEntriesInput } from "../shared/list-entries";
import { walkOrder } from "../shared/list-keys";

// one-ranking-for-every-workspace-search: the sidebar filter and Home's search rank a match the same way.
const NOW = Date.parse("2026-11-09T09:50:00.000Z");
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();
const item = (id: string, title: string, line: string, group: string, minutes = 30) =>
  ({ key: `ws:${id}`, agentId: `agent-${id}`, workspaceId: id, title, agent: null, project: "example/app", group, tier: null, line, at: ago(minutes), activityAt: ago(minutes) });

/** A Needs-you group where rows that match only in their second line come before rows whose title matches. */
function fixture(): { model: HomeModel; index: ReturnType<typeof indexDocs> } {
  const needs = [
    item("invoices", "Invoice export", "Waiting on others · Follow-up doesn't wake it", "needs", 5),
    item("audit", "Audit log retention", "Ask: should the export follow the retention window?", "needs", 10),
    item("hooks", "Webhook retries", "Permission · Run the migration on dev-box", "needs", 15),
    item("playbook", "Unfollow flow", "Review the copy", "needs", 18),
    item("onboard", "Follow-up email for new accounts", "Decision · Send it after the first login?", "needs", 20),
    item("digest", "Weekly digest follow up", "Review the template", "needs", 25),
  ];
  const waiting = [
    item("reports", "Usage reports", "Follow-up keeps watching the checks", "waiting", 40),
    item("followers", "Followers count", "Checks are running", "waiting", 50),
  ];
  const groups = [{ id: "needs", title: "Needs you", items: needs }, { id: "waiting", title: "Waiting on others", items: waiting }];
  const model = { groups, needs: needs.length, byKey: new Map([...needs, ...waiting].map(s => [s.key, s])) } as unknown as HomeModel;
  const paseo = [{ id: "hooks", name: "Webhook retries", project: "example/app", activityAt: ago(15), branch: "feat/follow-redirects" }];
  return { model, index: indexDocs(homeSearchDocs({ model, paseo, tracked: [] })) };
}
const keysOf = (m: HomeModel, group: string) => m.groups.find(g => g.id === group)!.items.map(s => s.key);

test("the sidebar filter ranks a title match above a match only in the row's second line, inside each group", () => {
  const { model, index } = fixture();
  const { model: narrowed } = filterHome(model, index, "follow", NOW);
  assert.deepEqual(keysOf(narrowed, "needs"), [
    // Title, whole word or word start, in the list's own order.
    "ws:onboard", "ws:digest",
    // Title, inside a word.
    "ws:playbook",
    // Branch.
    "ws:hooks",
    // The second line only, in the list's own order.
    "ws:invoices", "ws:audit",
  ]);
  // Groups keep their order; the ranking applies inside each one.
  assert.deepEqual(narrowed.groups.map(g => g.id), ["needs", "waiting"]);
  assert.deepEqual(keysOf(narrowed, "waiting"), ["ws:followers", "ws:reports"]);
});

test("Home's search and the filter rank with one scorer: the same tiers, the list's order only breaking ties", () => {
  const { model, index } = fixture();
  const found = search(index, "follow", NOW, Infinity);
  const tierOf = new Map(found.map(h => [h.key, h.rank!.tier]));
  const { model: narrowed } = filterHome(model, index, "follow", NOW);
  for (const g of narrowed.groups) {
    const ranks = g.items.map(s => tierOf.get(s.key)!);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${g.id}: tiers never go back up`);
  }
  // Home search puts every title match above every other match.
  const titleFirst = found.map(h => h.rank!.tier === 0);
  assert.deepEqual(titleFirst, [...titleFirst].sort((a, b) => Number(b) - Number(a)));
  assert.ok(found.slice(0, 2).every(h => ["ws:onboard", "ws:digest", "ws:followers"].includes(h.key)), found.map(h => h.key).join());
});

test("the keyboard walk follows the ranked order the filter draws", () => {
  const { model, index } = fixture();
  const { model: narrowed, hits } = filterHome(model, index, "follow", NOW);
  const input: ListEntriesInput = { model: narrowed, closed: new Set(), openProjects: new Set(), pages: {}, briefLine: undefined, results: null,
    hits: hits as Map<string, SearchHit>, filter: null, overseer: false, touch: false, afterNeeds: false } as ListEntriesInput;
  assert.deepEqual(walkOrder(listEntries(input)), [...keysOf(narrowed, "needs"), ...keysOf(narrowed, "waiting")]);
});

test("the filter has no ranking of its own", async () => {
  const src = await readFile(new URL("../shared/search.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export function filterHome"));
  assert.match(fn, /byRank/);
  assert.doesNotMatch(fn, /FIELD_WEIGHT|tokenMatch|\.score/, "the filter reuses search's rank, never a score of its own");
});
