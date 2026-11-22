import type { GithubApi } from "../../server/github-api";

/**
 * A fake GitHub for PR statistics: a fictional repository (`example/app`) with `count` PRs over the last ~100 days,
 * answering the sync's page query (keyset-paged by updatedAt, newest first) and its review follow-ups, with a
 * `rateLimit` on every answer. Deterministic (seeded), no network.
 *
 * What it holds, so every rule has something to bite on: people (alice, bob, carol, dan, erin, frank), bots by type
 * (`dependabot`, a Bot) and by suffix (`renovate[bot]`), a human-looking service account (`deploy-robot`), deleted
 * users (author null), drafts that became ready and drafts that never did, review requests to people and to the team
 * `@backend` (some while still a draft), stacks (a PR based on another PR's head), reviews past the page's 20, the
 * author's own replies and bot comments.
 */
type Node = Record<string, any>;
export const PEOPLE = ["alice", "bob", "carol", "dan", "erin", "frank"];
const user = (login: string) => ({ login, __typename: "User" });
const BOTS = [{ login: "dependabot", __typename: "Bot" }, { login: "renovate[bot]", __typename: "Bot" }];
const iso = (s: number) => new Date(s * 1000).toISOString();

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export type Call = { kind: "page" | "reviews"; first: number | null; after: string | null; numbers: number[] };
export class FakeStatsGithub implements GithubApi {
  prs: Node[] = [];
  calls: Call[] = [];
  /** Points each answer costs (the real query: 1 per page of 25). */
  cost = 1;
  remaining = 5000;
  limit = 5000;
  resetAt: number;
  /** Return an Error to throw, a body to answer with, or nothing for the normal answer. */
  fail: ((call: Call) => Error | Node | undefined) | null = null;
  /** Answer a page query with this many nodes at most, whatever `first` asked (a page GitHub cut short). */
  repo = "example/app";

  constructor(private clock: () => number, o: { count?: number; seed?: number } = {}) {
    this.resetAt = Math.floor(clock() / 1000) + 3600;
    const random = rng(o.seed ?? 7);
    const now = Math.floor(clock() / 1000);
    const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]!;
    const count = o.count ?? 300;
    let stackHead: string | null = null, stackLeft = 0;
    for (let i = 1; i <= count; i++) {
      const created = now - Math.floor((1 - i / (count + 1)) * 100 * 86_400) - Math.floor(random() * 3600);
      const kind = random();
      const author: Node | null = kind < 0.06 ? pick(BOTS) : kind < 0.08 ? null : kind < 0.1 ? user("deploy-robot") : user(pick(PEOPLE));
      const head = `feature-${i}`;
      let base = "main";
      if (stackLeft > 0 && stackHead && author?.__typename === "User") { base = stackHead; stackLeft--; } else if (random() < 0.08 && author?.__typename === "User") { stackLeft = 2 + Math.floor(random() * 3); }
      stackHead = stackLeft > 0 ? head : null;
      const openedDraft = random() < 0.25;
      const neverReady = openedDraft && random() < 0.3;
      const ready = openedDraft && !neverReady ? created + 600 + Math.floor(random() * 86_400) : null;
      const readyAt = ready ?? (neverReady ? null : created);
      const timeline: Node[] = [];
      if (ready) timeline.push({ __typename: "ReadyForReviewEvent", createdAt: iso(ready) });
      const requested: string[] = [];
      if (readyAt !== null || random() < 0.5) {
        const at = (readyAt ?? created) + (random() < 0.2 ? -300 : 60 + Math.floor(random() * 3600));
        const who: Node = random() < 0.2 ? { __typename: "Team", slug: "backend" } : user(pick(PEOPLE.filter(p => p !== author?.login)));
        timeline.push({ __typename: "ReviewRequestedEvent", createdAt: iso(Math.max(created, at)), requestedReviewer: who });
        if (who.__typename === "User") requested.push(who.login);
      }
      const reviews: Node[] = [];
      const busy = i % 50 === 0;
      if (readyAt !== null && author) {
        const n = busy ? 25 : Math.floor(random() * 4);
        for (let r = 0; r < n; r++) {
          const by = busy ? user(`reviewer${r}`) : r === 0 && requested[0] ? user(requested[0]) : random() < 0.1 ? pick(BOTS) : user(pick(PEOPLE));
          reviews.push({ author: by, state: pick(["APPROVED", "COMMENTED", "CHANGES_REQUESTED"]), submittedAt: iso(readyAt + 1800 + r * 900 + Math.floor(random() * 86_400)) });
        }
        if (random() < 0.15) reviews.push({ author, state: "COMMENTED", submittedAt: iso(readyAt + 1200) });
      }
      reviews.sort((p, q) => Date.parse(p.submittedAt) - Date.parse(q.submittedAt));
      const comments: Node[] = [];
      if (random() < 0.4) comments.push({ createdAt: iso(created + 120), author: pick(BOTS) });
      if (random() < 0.4 && author) comments.push({ createdAt: iso(created + 300), author });
      if (random() < 0.4) comments.push({ createdAt: iso((readyAt ?? created) + 2400), author: user(pick(PEOPLE)) });
      const fate = random();
      const end = created + 3600 + Math.floor(random() * 5 * 86_400);
      const state = neverReady ? (fate < 0.5 ? "CLOSED" : "OPEN") : fate < 0.6 && end < now ? "MERGED" : fate < 0.7 && end < now ? "CLOSED" : "OPEN";
      const last = Math.max(created, ...reviews.map(r => Date.parse(r.submittedAt) / 1000), ...comments.map(c => Date.parse(c.createdAt) / 1000), state === "OPEN" ? 0 : end);
      this.prs.push({
        number: i, title: `Change ${i}: tidy the ${pick(["sync job", "retry budget", "settings page", "build cache", "log viewer"])}`,
        createdAt: iso(created), updatedAt: iso(Math.min(now, Math.floor(last))), closedAt: state === "OPEN" ? null : iso(Math.min(now, end)), mergedAt: state === "MERGED" ? iso(Math.min(now, end)) : null,
        state, isDraft: state === "OPEN" && neverReady, additions: Math.floor(random() * 400), deletions: Math.floor(random() * 120), changedFiles: 1 + Math.floor(random() * 12),
        author, baseRefName: base, headRefName: head,
        // Never sent by the real query; here so a privacy test can prove the sync doesn't keep what it isn't asked for.
        body: `Secret body of PR ${i}`,
        _reviews: reviews, _comments: comments, _timeline: timeline,
      });
    }
  }

  /** PRs updated in the last `days` days (what a full backfill of that window must read). */
  inWindow(days: number): Node[] { const from = this.clock() / 1000 - days * 86_400; return this.prs.filter(p => Date.parse(p.updatedAt) / 1000 >= from); }
  /** Bumps a PR's updatedAt to now with a new review (an incremental pass must see it). */
  touch(number: number, by = "carol"): void {
    const pr = this.prs.find(p => p.number === number)!;
    const t = iso(Math.floor(this.clock() / 1000));
    pr._reviews.push({ author: user(by), state: "APPROVED", submittedAt: t });
    pr.updatedAt = t;
  }

  private sorted(): Node[] { return [...this.prs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number); }
  private node(pr: Node): Node {
    const { _reviews, _comments, _timeline, body: _body, ...rest } = pr;
    return { ...rest,
      reviews: { totalCount: _reviews.length, nodes: _reviews.slice(0, 20) },
      comments: { totalCount: _comments.length, nodes: _comments.slice(0, 10) },
      timelineItems: { pageInfo: { hasNextPage: _timeline.length > 25 }, nodes: _timeline.slice(0, 25) } };
  }
  private rate() { this.remaining -= this.cost; return { cost: this.cost, remaining: this.remaining, resetAt: new Date(this.resetAt * 1000).toISOString(), limit: this.limit }; }

  async graphql(repo: string, query: string, variables: Record<string, string>): Promise<Node> {
    if (repo !== this.repo) return { data: { rateLimit: this.rate(), repository: null }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a Repository with the name '${repo}'.` }] };
    const aliases = [...query.matchAll(/p(\d+):pullRequest\(number:(\d+)\)/g)].map(m => Number(m[2]));
    const first = Number(/pullRequests\(first:(\d+)/.exec(query)?.[1] ?? NaN);
    const call: Call = aliases.length ? { kind: "reviews", first: null, after: null, numbers: aliases } : { kind: "page", first, after: variables.after ?? null, numbers: [] };
    this.calls.push(call);
    const failure = this.fail?.(call);
    if (failure instanceof Error) throw failure;
    if (failure) return failure;
    if (call.kind === "reviews") {
      const repository: Node = {};
      aliases.forEach((n, i) => { const pr = this.prs.find(p => p.number === n); repository[`p${i}`] = pr ? { number: n, reviews: { nodes: pr._reviews.slice(0, 100) } } : null; });
      return { data: { rateLimit: this.rate(), repository } };
    }
    const all = this.sorted();
    const start = call.after ? Number(Buffer.from(call.after, "base64").toString().split(":")[1]) : 0;
    const slice = all.slice(start, start + first);
    const end = start + slice.length;
    return { data: { rateLimit: this.rate(), repository: { defaultBranchRef: { name: "main" }, pullRequests: {
      pageInfo: { hasNextPage: end < all.length, endCursor: slice.length ? Buffer.from(`cursor:${end}`).toString("base64") : null },
      nodes: slice.map(p => this.node(p)) } } } };
  }
  async rest(): Promise<unknown> { throw new Error("PR statistics read no REST"); }
}
