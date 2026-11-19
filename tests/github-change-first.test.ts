import test from "node:test";
import assert from "node:assert/strict";
import { Github, fingerprint } from "../server/github";
import type { GithubApi } from "../server/github-api";
import { TICK_MS, POLL_IDLE_MS, RUNNING_FULL_MS, SAFETY_READ_MS, OBSERVATION_FRESH_MS, probeVerdict } from "../shared/poll";
import { clock, pr } from "./fixtures";

// Invariant github-reads-scale-with-change: Follow-up's GitHub reads scale with what changed, not with how many PRs it
// tracks. 2026-11-19 live: 100 open PRs (96 in one repository) cost 4300-6400 GraphQL points an hour re-read in full,
// plus ~2000 per pushed 60-PR stack, and the account's 5000-point budget ran out in five hours that day.

type Row = {
  state?: string; head?: string; updatedAt?: string; mergeable?: string; mergeStateStatus?: string; reviewDecision?: string;
  threads?: { id: string; isResolved: boolean }[]; running?: number; success?: number; failure?: number;
};
/** A fake GitHub answering full reads (one point per PR, like GitHub's ~1.07) and probes (three requests per PR). */
function fakeGithub(rows: Map<string, Row>) {
  const calls = { full: 0, probes: 0, points: 0, fullPrs: [] as string[] };
  const counts = (r: Row) => [
    ...(r.running ? [{ state: "IN_PROGRESS", count: r.running }] : []), ...(r.success ? [{ state: "SUCCESS", count: r.success }] : []), ...(r.failure ? [{ state: "FAILURE", count: r.failure }] : []),
  ];
  const nodes = (r: Row) => [
    ...Array.from({ length: r.running ?? 0 }, (_, i) => ({ name: `run${i}`, status: "IN_PROGRESS", conclusion: null })),
    ...Array.from({ length: r.success ?? 0 }, (_, i) => ({ name: `ok${i}`, status: "COMPLETED", conclusion: "SUCCESS" })),
    ...Array.from({ length: r.failure ?? 0 }, (_, i) => ({ name: `bad${i}`, status: "COMPLETED", conclusion: "FAILURE" })),
  ];
  const common = (repo: string, number: number, r: Row) => ({
    state: r.state ?? "OPEN", headRefOid: r.head ?? "h1", updatedAt: r.updatedAt ?? "2026-01-01T09:00:00Z", baseRefName: "main", isDraft: false,
    mergeable: r.mergeable ?? "MERGEABLE", mergeStateStatus: r.mergeStateStatus ?? "CLEAN", reviewDecision: r.reviewDecision ?? "APPROVED", isInMergeQueue: false, autoMergeRequest: null,
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: (r.threads ?? []).map(t => ({ ...t, comments: { nodes: [{ updatedAt: "2026-01-01T09:00:00Z" }] } })) },
    number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`,
  });
  const api: GithubApi = {
    async graphql(repo, query) {
      if (query.includes("r0:repository")) {
        calls.probes++;
        const data: Record<string, any> = {};
        let prs = 0;
        for (const segment of query.split(/(?=r\d+:repository\()/).slice(1)) {
          const [, r, owner, name] = segment.match(/^(r\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)/)!; const body = segment;
          data[r] = {};
          for (const [, alias, number] of body.matchAll(/(p\d+):pullRequest\(number:(\d+)\)/g)) {
            prs++; const row = rows.get(`${owner}/${name}#${number}`) ?? {};
            data[r][alias] = { ...common(`${owner}/${name}`, Number(number), row), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { checkRunCountsByState: counts(row), statusContextCountsByState: [] } } } }] } };
          }
        }
        const cost = Math.max(1, Math.ceil((prs * 3) / 100)); calls.points += cost;
        return { data: { rateLimit: { cost, remaining: 4000, resetAt: "2099-01-01T00:00:00Z", limit: 5000 }, ...data } };
      }
      calls.full++;
      const repository: Record<string, unknown> = { defaultBranchRef: { name: "main", branchProtectionRule: null, rules: { pageInfo: { hasNextPage: false }, nodes: [] } } };
      let prs = 0;
      for (const [, alias, number] of query.matchAll(/(p\d+):pullRequest\(number:(\d+)\)/g)) {
        prs++; calls.fullPrs.push(`${repo}#${number}`);
        const row = rows.get(`${repo}#${number}`) ?? {};
        repository[alias] = {
          ...common(repo, Number(number), row), headRefName: `b${number}`, author: { login: "alice" },
          reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [] }, latestReviews: { pageInfo: { hasNextPage: false }, nodes: [] },
          baseRef: { branchProtectionRule: null, rules: { pageInfo: { hasNextPage: false }, nodes: [] }, associatedPullRequests: { nodes: [] } },
          mergeCommit: null, mergedAt: null,
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { checkRunCountsByState: counts(row), statusContextCountsByState: [], pageInfo: { hasNextPage: false }, nodes: nodes(row) } } } }] },
        };
      }
      calls.points += prs; // ~1.07 a PR live; one here keeps the arithmetic plain
      return { data: { rateLimit: { cost: prs, remaining: 4000, resetAt: "2099-01-01T00:00:00Z", limit: 5000 }, repository } };
    },
    async rest() { return []; },
  };
  return { api, calls };
}
function fleet(n: number, repos: number, patch: (i: number) => Row = () => ({})) {
  const rows = new Map<string, Row>(); const prs = [];
  for (let i = 0; i < n; i++) {
    const repo = `acme/app${i % repos}`; const number = i + 1;
    rows.set(`${repo}#${number}`, patch(i));
    prs.push(pr({ key: `${repo}#${number}`, repo, number, snapshot: null }));
  }
  return { rows, prs };
}
/** Ticks until RECENT_CHANGE_MS has passed since the first reads, so every PR is settled. */
async function settle(github: Github, prs: ReturnType<typeof pr>[], clockRef: { now: number }, o: { hot?: Set<string> } = {}) {
  for (let i = 0; i < 30; i++) { await github.observe(prs, { background: true, ...o }); clockRef.now += TICK_MS; }
}

test("github-reads-scale-with-change: a poll where nothing changed costs at most 3 points for 100 PRs, and no full read", async () => {
  const t = { now: clock };
  const { rows, prs } = fleet(100, 4);
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => t.now);
  await settle(github, prs, t);
  const before = { ...f.calls };
  // An hour of ticks with nothing changing: probes only (every PR is due each POLL_IDLE_MS), then one safety read.
  for (let i = 0; i < SAFETY_READ_MS / TICK_MS - 31; i++) { await github.observe(prs, { background: true }); t.now += TICK_MS; }
  assert.equal(f.calls.full, before.full, "nothing changed: no full read before the safety read");
  const probes = f.calls.probes - before.probes;
  assert.ok(probes > 0);
  assert.ok((f.calls.points - before.points) / probes <= 3, `a probe of 100 PRs in 4 repositories costs at most 3 points (${(f.calls.points - before.points) / probes})`);
  // On main every due PR was read in full: 100 points a minute.
  assert.ok(f.calls.points - before.points < 100, `${f.calls.points - before.points} points in ~23 minutes`);
});

test("github-reads-scale-with-change: a change that matters reads only that PR in full, at once", async () => {
  const t = { now: clock };
  const { rows, prs } = fleet(10, 1, () => ({ success: 3, threads: [{ id: "T1", isResolved: false }] }));
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => t.now);
  await settle(github, prs, t);
  const changes: [string, (r: Row) => void][] = [
    ["a new head", r => { r.head = "h2"; }],
    ["updatedAt (a comment, a review, a reviewer request, the title)", r => { r.updatedAt = "2026-01-01T11:00:00Z"; }],
    ["merged", r => { r.state = "MERGED"; }],
    ["mergeability", r => { r.mergeable = "CONFLICTING"; r.mergeStateStatus = "DIRTY"; }],
    ["review decision", r => { r.reviewDecision = "CHANGES_REQUESTED"; }],
    ["a thread resolved (no updatedAt bump)", r => { r.threads = [{ id: "T1", isResolved: true }]; }],
    ["checks started (a re-run on the same head)", r => { r.running = 2; }],
  ];
  for (const [i, [what, change]] of changes.entries()) {
    const target = prs[i];
    change(rows.get(target.key)!);
    f.calls.fullPrs.length = 0;
    // A settled PR is probed once a minute; the hot set makes it due every tick, like a busy workspace.
    const observed = await github.observe(prs, { background: true, hot: new Set([target.key]) });
    t.now += TICK_MS;
    assert.deepEqual(f.calls.fullPrs, [target.key], `${what}: only that PR is read in full`);
    assert.ok(observed.get(target.key)!.snapshot, what);
    await settle(github, prs, t);
  }
});

test("github-reads-scale-with-change: checks: a new failure or all finishing reads at once; one more passing waits RUNNING_FULL_MS", async () => {
  const t = { now: clock };
  const { rows, prs } = fleet(3, 1, () => ({ running: 4, success: 1 }));
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => t.now);
  await settle(github, prs, t);
  const hot = new Set(prs.map(p => p.key));
  const tick = async () => { f.calls.fullPrs.length = 0; const o = await github.observe(prs, { background: true, hot }); t.now += TICK_MS; return o; };
  await github.observe(prs, { background: true, fresh: hot }); t.now += TICK_MS; // a full read just now (a Refresh)
  // One more check passed while others still run: not decisive (a required one passing moves mergeStateStatus).
  Object.assign(rows.get(prs[0].key)!, { running: 3, success: 2 });
  assert.deepEqual((await tick(), f.calls.fullPrs), []);
  // A new failure reads at once and shows.
  Object.assign(rows.get(prs[1].key)!, { running: 3, failure: 1 });
  const failed = await tick();
  assert.deepEqual(f.calls.fullPrs, [prs[1].key]);
  assert.deepEqual(failed.get(prs[1].key)!.snapshot!.otherFailedChecks, ["bad0"]);
  // All checks finished: read at once, checks no longer running.
  Object.assign(rows.get(prs[2].key)!, { running: 0, success: 5 });
  const done = await tick();
  assert.deepEqual(f.calls.fullPrs, [prs[2].key]);
  assert.equal(done.get(prs[2].key)!.snapshot!.checksRunning, false);
  // The deferred count change on prs[0] reads once RUNNING_FULL_MS passed since its last full read.
  let read = false;
  for (let i = 0; i < RUNNING_FULL_MS / TICK_MS + 1 && !read; i++) { await tick(); read = (f.calls.fullPrs as string[]).includes(prs[0].key); }
  assert.ok(read, "running checks whose counts moved are read in full within RUNNING_FULL_MS");
});

test("github-reads-scale-with-change: an unchanged probe keeps the observation fresh for the completion gate", async () => {
  const t = { now: clock };
  const { rows, prs } = fleet(2, 1);
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => t.now);
  await settle(github, prs, t);
  t.now += POLL_IDLE_MS;
  const fullBefore = f.calls.full;
  const observed = await github.observe(prs, { background: true });
  assert.equal(f.calls.full, fullBefore);
  for (const p of prs) assert.ok(t.now - Date.parse(observed.get(p.key)!.snapshot!.observedAt) < OBSERVATION_FRESH_MS);
});

test("github-reads-scale-with-change: the safety read runs SAFETY_READ_MS after the last full read; Refresh and foreground reads read in full", async () => {
  const t = { now: clock };
  const { rows, prs } = fleet(4, 1);
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => t.now);
  await settle(github, prs, t);
  f.calls.fullPrs.length = 0;
  await github.observe(prs, { background: true, fresh: new Set([prs[0].key]) });
  assert.deepEqual(f.calls.fullPrs, [prs[0].key], "Refresh reads its PRs in full");
  f.calls.fullPrs.length = 0;
  await github.observe([prs[1]]);
  assert.deepEqual(f.calls.fullPrs, [prs[1].key], "an agent tool's foreground read is a full read");
  f.calls.fullPrs.length = 0;
  for (let i = 0; i < SAFETY_READ_MS / TICK_MS + 4; i++) { await github.observe(prs, { background: true }); t.now += TICK_MS; }
  for (const p of prs) assert.ok(f.calls.fullPrs.includes(p.key), `${p.key}: a safety read`);
  assert.ok(f.calls.fullPrs.length <= prs.length * 2);
});

test("github-reads-scale-with-change: a pushed 60-PR stack costs a fraction of re-reading it every tick", async () => {
  const t = { now: clock };
  const { rows, prs } = fleet(60, 1, () => ({ success: 6 }));
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => t.now);
  await settle(github, prs, t);
  const hot = new Set(prs.slice(0, 10).map(p => p.key));
  const start = f.calls.points;
  // A restack: every head moves, CI starts on each, the checks finish one by one over 12 minutes.
  for (const p of prs) Object.assign(rows.get(p.key)!, { head: "h2", updatedAt: "2026-01-01T12:00:00Z", running: 6, success: 0 });
  for (let i = 0; i < 80; i++) {
    if (i > 0 && i % 8 === 0) for (const p of prs) { const r = rows.get(p.key)!; if (r.running) { r.running--; r.success = (r.success ?? 0) + 1; } }
    await github.observe(prs, { background: true, hot }); t.now += TICK_MS;
  }
  const spent = f.calls.points - start;
  // On main: every-tick full reads for 5 minutes after the push, then every 30 s: ~1900 points for these 20 minutes.
  assert.ok(spent <= 400, `${spent} points for a pushed 60-PR stack over 20 minutes`);
  for (const p of prs) assert.equal((await github.observe([p], { background: true })).get(p.key)!.snapshot!.checksRunning, false);
});

test("closed is final like merged: a closed PR with a known status isn't read again, only on Refresh", async () => {
  const t = { now: clock };
  const { rows, prs } = fleet(2, 1, () => ({ state: "CLOSED" }));
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => t.now);
  await github.observe(prs, { background: true });
  const stored = prs.map(p => ({ ...p, snapshot: { ...p.snapshot!, ...github["last"].get(p.key)!.snapshot! } }));
  const before = f.calls.points;
  for (let i = 0; i < 240; i++) { await github.observe(stored, { background: true }); t.now += TICK_MS; }
  assert.equal(f.calls.points, before, "an hour costs nothing");
  // A cold start (a new worker) doesn't read it either.
  const cold = new Github(undefined, undefined, undefined, f.api, () => t.now);
  await cold.observe(stored, { background: true });
  assert.equal(f.calls.points, before);
  await github.observe(stored, { background: true, fresh: new Set([stored[0].key]) });
  assert.equal(f.calls.points, before + 1, "the developer's Refresh reads it");
});

test("a probe that fails falls back to full reads; one that hits the limit keeps the last observations", async () => {
  const t = { now: clock };
  const { rows, prs } = fleet(3, 1);
  const f = fakeGithub(rows);
  const github = new Github(undefined, undefined, undefined, f.api, () => t.now);
  await settle(github, prs, t);
  const graphql = f.api.graphql;
  f.api.graphql = async (repo, query, vars) => { if (query.includes("r0:repository")) throw new Error("GitHub HTTP 502"); return graphql(repo, query, vars); };
  f.calls.fullPrs.length = 0; t.now += POLL_IDLE_MS;
  await github.observe(prs, { background: true });
  assert.deepEqual(f.calls.fullPrs.sort(), prs.map(p => p.key).sort());
  f.api.graphql = async (repo, query, vars) => { if (query.includes("r0:repository")) return { data: null, errors: [{ type: "RATE_LIMITED" }] }; return graphql(repo, query, vars); };
  f.calls.fullPrs.length = 0; t.now += POLL_IDLE_MS;
  const held = await github.observe(prs, { background: true });
  assert.deepEqual(f.calls.fullPrs, [], "no full read on an account that just hit its limit");
  assert.ok([...held.values()].every(o => o.error === null && o.snapshot));
});

test("fingerprint: core changes and check counts; null when a probe can't compare", () => {
  const base = { updatedAt: "u", state: "OPEN", headRefOid: "h", baseRefName: "main", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", isInMergeQueue: false, autoMergeRequest: null,
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { checkRunCountsByState: [{ state: "IN_PROGRESS", count: 2 }, { state: "FAILURE", count: 1 }], statusContextCountsByState: [{ state: "PENDING", count: 1 }] } } } }] } };
  const print = fingerprint(base)!;
  assert.equal(print.running, 3); assert.equal(print.failed, 1);
  assert.equal(fingerprint({ ...base, updatedAt: undefined }), null, "no updatedAt (an older fake or host): full reads");
  assert.equal(fingerprint({ ...base, reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [] } }), null, "threads past one page");
  assert.ok(fingerprint({ ...base, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }), "no checks at all is comparable");
  assert.equal(probeVerdict(print, print, 0), "same");
  assert.equal(probeVerdict(print, print, SAFETY_READ_MS), "read");
});
