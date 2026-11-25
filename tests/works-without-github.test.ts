import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testStore, rm } from "./support/store-temp-dir";
import { clock, pr, snapshot, workspace } from "./fixtures";
import { GithubSetup, LOOK_MS } from "../server/github-setup";
import { Github } from "../server/github";
import { httpApi } from "../server/github-api";
import { Engine, type Gateway, type Runtime } from "../server/engine";
import { Store } from "../server/store";
import { stateSchema } from "../shared/model";
import { liveLine } from "../shared/attention";
import { GithubOffError, githubOffLine, isGithubOff } from "../shared/github-setup";

/**
 * Invariant 110, `works-without-github`. GitHub is an optional integration: a host without the GitHub CLI (or with it
 * signed out) runs everything that isn't about GitHub as before; every GitHub surface and agent tool answers in one
 * line what's missing and how to turn it on; nothing spawns gh, retries or logs on a timer while it's off; and
 * installing gh and signing in is picked up without a restart. 2026-11-25 (the brief "gh-optional", harness runs with
 * no gh on PATH and with gh signed out): setup showed GitHub as a red failure, PRs read "check gh authentication",
 * Merge and Add reviewers said "Refresh" (which could never help), wait_for_checks promised a message it could never
 * send, and signed out the worker spawned `gh auth token` 8 times in 90 s for nothing. The real worker on a host with
 * no gh: tests/works-without-github-worker.test.ts.
 */

type Stat = { mtimeMs: number; size: number; isFile: boolean } | null;
function fakeHost(files: Record<string, Stat>, token: () => string) {
  const spawns: string[] = [];
  let now = clock;
  const setup = new GithubSetup({
    env: { PATH: "/fake/bin:/fake/usr", HOME: "/fake/home", FOLLOW_UP_GH_BIN: "" },
    now: () => now,
    stat: path => files[path] ?? null,
    run: async (bin, args) => { spawns.push([bin, ...args].join(" ")); const t = token(); if (!t) throw new Error("not logged in"); return t + "\n"; },
  });
  return { setup, spawns, files, advance: (ms: number) => { now += ms; } };
}
const GH = { mtimeMs: 1, size: 100, isFile: true };

test("works-without-github: no gh is off without a spawn; installing it and signing in is picked up without a restart", async () => {
  let token = "";
  const h = fakeHost({}, () => token);
  assert.deepEqual(await h.setup.current(), { on: false, off: "missing" });
  assert.equal(h.setup.off(), "missing");
  for (let i = 0; i < 20; i++) { h.advance(LOOK_MS); await h.setup.current(); }
  assert.deepEqual(h.spawns, [], "nothing spawns while there is no gh");
  // gh installed, not signed in: the next look sees the binary and checks once.
  h.files["/fake/usr/gh"] = GH;
  h.advance(LOOK_MS);
  assert.deepEqual(await h.setup.current(), { on: false, off: "signed-out" });
  assert.equal(h.spawns.length, 1);
  for (let i = 0; i < 20; i++) { h.advance(LOOK_MS); await h.setup.current(); }
  assert.equal(h.spawns.length, 1, "signed out: no retry while nothing changed");
  // gh auth login writes hosts.yml: the next look checks again and GitHub is on.
  token = "gho_fixture"; h.files["/fake/home/.config/gh/hosts.yml"] = { mtimeMs: 5, size: 40, isFile: true };
  h.advance(LOOK_MS);
  assert.deepEqual(await h.setup.current(), { on: true, explicit: false });
  assert.equal(h.spawns.length, 2);
  assert.equal(h.setup.off(), null);
});

test("works-without-github: a token GitHub later refuses checks once; an explicit token needs no gh", async () => {
  let token = "gho_fixture";
  const h = fakeHost({ "/usr/bin/gh": GH }, () => token);
  assert.equal((await h.setup.current()).on, true);
  token = ""; h.setup.invalidate();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(await h.setup.current(), { on: false, off: "signed-out" });
  assert.equal(h.spawns.length, 2);
  const explicit = new GithubSetup({ env: { PATH: "", GH_TOKEN: "ghp_fixture" }, stat: () => null, run: async () => { throw new Error("never spawned"); } });
  assert.deepEqual(await explicit.current(), { on: true, explicit: true });
  assert.equal(await explicit.writeOff(), "missing", "writes still need gh itself");
});

test("works-without-github: the default words", () => {
  assert.ok(new GithubOffError("missing").message.startsWith("GitHub isn't connected. The GitHub CLI isn't installed: Install the GitHub CLI (https://cli.github.com)"));
  assert.ok(new GithubOffError("signed-out", "Merging").message.startsWith("Merging needs GitHub. The GitHub CLI isn't signed in: Run gh auth login"));
});

test("works-without-github: every GitHub read answers GithubOffError at once, with no token lookup", async () => {
  let lookups = 0; let requests = 0;
  const setup = { current: async () => ({ on: false as const, off: "missing" as const }), invalidate: () => undefined };
  const api = httpApi({ setup, tokens: async () => { lookups++; return "t"; }, accountToken: async () => { lookups++; return "t"; }, status: async () => { lookups++; return ""; }, request: (async () => { requests++; throw new Error("no"); }) as never });
  for (const call of [() => api.rest("example/app", "repos/example/app"), () => api.graphql("example/app", "query{}", {}), () => api.restAs(null, "user"), () => api.accounts(), () => api.send("example/app", "POST", "repos/example/app/issues", {})]) {
    await assert.rejects(call(), (e: unknown) => isGithubOff(e) && /GitHub CLI isn't installed/.test((e as Error).message));
  }
  assert.equal(lookups, 0); assert.equal(requests, 0);
});

test("works-without-github: the engine reads nothing, keeps what it knew and says why on the workspace", async t => {
  const root = await mkdtemp(join(tmpdir(), "follow-no-gh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const known = pr();
  const never = pr({ key: "example/app#2", number: 2, snapshot: null });
  const store = testStore(Store, root); await store.mutate(s => { s.workspaces.push(workspace({ prs: [known, never] })); });
  let off: "missing" | null = "missing";
  let reads = 0;
  const github = new Github(undefined, undefined, undefined, { graphql: async () => { reads++; return {}; }, rest: async () => { reads++; return {}; } }, () => clock);
  github.setup = { current: async () => off ? { on: false, off } : { on: true, explicit: false }, writeOff: async () => off };
  const runtime: Runtime = { busy: false, reason: null, archived: false };
  const gateway: Gateway = { prepareRecovery: async () => ({ agentId: "r", contextPath: "/r" }), observe: async () => runtime, send: async () => undefined, label: async () => undefined };
  const engine = new Engine(store, github, gateway, () => clock);
  await engine.tick();
  let w = (await store.snapshot()).workspaces[0];
  assert.equal(reads, 0, "no GitHub read while GitHub is off");
  assert.equal(w.githubOff, "missing");
  assert.ok(w.prs[0].snapshot?.complete, "a known PR keeps its last status");
  assert.equal(w.prs[1].snapshot, null);
  assert.match(w.prs[1].error ?? "", /^PR status needs GitHub\. The GitHub CLI isn't installed/);
  assert.equal(w.batches.length, 0, "no repairs from nothing read");
  assert.match(githubOffLine(w.githubOff)!.title, /GitHub not connected/);
  assert.equal(liveLine(w, clock).text, "GitHub not connected · PR status is off", "Home's line says why, never \"retrying\"");
  // Turned on: the next tick reads and the line goes.
  off = null;
  await engine.tick();
  w = (await store.snapshot()).workspaces[0];
  assert.ok(reads > 0, "reads resume once GitHub is on");
  assert.equal(w.githubOff ?? null, null);
  stateSchema.parse(await store.snapshot());
});
