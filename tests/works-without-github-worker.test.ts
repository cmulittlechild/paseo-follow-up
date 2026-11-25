import test from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeServer, hanging, hangingHost, type Registered } from "./support/hanging-host";
import { seed } from "./support/seed";
import { FIXTURE } from "./support/sample-input";

/**
 * Invariant 110, `works-without-github` (tests/works-without-github.test.ts has the rest): the real worker, contribute()
 * from index.server.ts in a temp PASEO_HOME, on a host with no gh. GitHub's own actions answer in one line what's
 * missing and how to turn it on, at once (they don't wait on the worker's start), and nothing runs gh.
 *
 * Everything server-side is imported after hangingHost(): index.server.ts and server/daemon.ts read PASEO_HOME at
 * import, and a static import here would point the worker at the real Paseo home.
 */

test("works-without-github: the real worker with no gh on the host", { timeout: 60_000 }, async t => {
  const host = await hangingHost();
  t.after(() => host.close());
  // No gh at all for token lookups; a gh first on PATH that logs, so any spawn of it (a write, a check) is caught.
  const log = join(host.root, "gh-spawns.log"); await writeFile(log, "");
  process.env.FOLLOW_UP_GH_BIN = join(host.root, "no-such-dir", "gh");
  delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN;
  const ghOnPath = join(process.env.PATH!.split(":")[0], "gh");
  await writeFile(ghOnPath, `#!/bin/sh\necho "gh $*" >> '${log}'\nexit 4\n`); await chmod(ghOnPath, 0o755);
  assert.ok(host.directory.startsWith(host.root), "the worker's data stays in the temp root");
  await seed(host.directory);
  const { stateSchema } = await import("../shared/model");
  const { pr, snapshot } = await import("./fixtures");
  const { isGithubOff } = await import("../shared/github-setup");
  const state = JSON.parse(await readFile(join(host.directory, "state.json"), "utf8"));
  state.workspaces[0].prs = [pr({ snapshot: snapshot({ state: "OPEN" }) }), pr({ key: "example/app#2", number: 2, snapshot: null })];
  await writeFile(join(host.directory, "state.json"), JSON.stringify(stateSchema.parse(state)));
  const { default: contribute } = await import("../index.server");
  const { server, handlers } = fakeServer();
  const stop = contribute(server as never) as unknown as () => Promise<void>;
  t.after(() => stop());
  const paseo = hanging();
  const call = async (name: string, input: unknown) => { const h = handlers.get(name) as Registered; return h.run(await h.input.parseAsync(input), { paseo }); };
  await call("follow.list", {});

  // Setup's GitHub row (optional, never a failure) is tests/onboarding.test.ts's; follow.onboarding-checks also asks
  // Paseo for providers, which this host never answers.
  // Every GitHub surface answers in one line what's missing and how to turn it on.
  const needs = (what: string) => (e: unknown) => isGithubOff(e) && new RegExp(`^${what} needs GitHub\\. The GitHub CLI isn't installed: Install the GitHub CLI`).test((e as Error).message);
  await assert.rejects(call("follow.prepare-pr-action", { workspaceId: FIXTURE.workspaceId, prKey: "example/app#1", kind: "merge" }), needs("Merging"));
  await assert.rejects(call("follow.request-reviewers", { workspaceId: FIXTURE.workspaceId, prKey: "example/app#1", reviewers: [{ login: "ravi", kind: "user" }] }), needs("Adding reviewers"));
  const suggestions = await call("follow.reviewer-suggestions", { repo: "example/app" }) as { error: string | null };
  assert.match(suggestions.error ?? "", /^Suggesting reviewers needs GitHub\./);
  const waiting = await call("follow.wait-for-checks", { agentId: FIXTURE.agentId }) as { text: string; waiting: string[] };
  assert.match(waiting.text, /^Waiting for checks needs GitHub\./); assert.deepEqual(waiting.waiting, [], "no watch that can never answer");

  await assert.rejects(call("follow.confirm-pr-action", { planId: "plan-1", scope: "target" }), needs("Merging"));
  // What isn't about GitHub works as with it: the workspace and its question. (End to end on a real daemon, with tasks,
  // Needs you, Home and the panel: scripts/check-no-gh.mjs, `npm run test:no-gh`; this host never answers Paseo.)
  const listed = await call("follow.list", {}) as { workspaces: { id: string }[] };
  assert.ok(listed.workspaces.some(w => w.id === FIXTURE.workspaceId));
  await call("follow.answer-question", { workspaceId: FIXTURE.workspaceId, questionId: FIXTURE.questionId, choice: "A", action: "send" });
  const got = await call("follow.get", { workspaceId: FIXTURE.workspaceId }) as { workspace: { questions: { id: string; answer: unknown }[] } };
  assert.ok(got.workspace.questions.find(q => q.id === FIXTURE.questionId)?.answer, "the answer is recorded");

  assert.equal((await readFile(log, "utf8")).trim(), "", "nothing ran gh");
});
