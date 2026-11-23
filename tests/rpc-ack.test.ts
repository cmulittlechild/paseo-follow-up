import test from "node:test";
import assert from "node:assert/strict";
import { fakeServer, hanging, hangingHost, settleTime, type Registered } from "./support/hanging-host";
import { timeAck } from "./support/ack-ratchet";
import { clientRpcs } from "./support/client-rpcs";
import { FIXTURE, sample } from "./support/sample-input";
import { seed } from "./support/seed";
import { slowFsync } from "./support/slow-disk";

/**
 * Invariant (2026-11-11, "Your answer wasn't sent. Plugin RPC timed out: follow-up.invoke"): every RPC the client
 * calls replies within ACK_MS even when everything slow hangs: the Paseo API never answers, the daemon socket accepts
 * and stays silent, gh, gt, mcpproxy, claude and codex never exit, and every fsync takes SLOW_FSYNC_MS
 * (an-ack-never-waits-on-the-disk: 2026-11-13/14 CI, follow.inbox-list waited 664 ms behind an inbox.json write and
 * follow.save-reviewers 1458 ms on reviewers.json's fsync, with the event loop idle; files save behind the reply,
 * server/write-behind.ts). Paseo gives a plugin RPC 30 s and then shows the
 * developer an error, whatever the handler later does; an answer that arrived 88 s later still read "wasn't sent".
 *
 * Slow side effects (sending to an agent, GitHub, the daemon) run after the reply, or are queued durably; a handler
 * only records and returns. The methods are not a hand-picked list: every handler contribute() registers that the
 * client calls (tests/support/client-rpcs.ts) runs against the real worker in a temp PASEO_HOME.
 *
 * EXEMPT holds the client RPCs that still wait on Paseo or GitHub before replying, each with why that is acceptable
 * for now. The list only shrinks: an exempt method that starts replying in time fails the test until it's removed.
 * "In time" is judged by `timeAck` (tests/support/ack-ratchet.ts), not the clock alone: a reply that came only because
 * a shared slow wait gave up meanwhile proves nothing, and the call is run again.
 * Nothing here may lose the developer's input: none of them carries words the developer typed.
 */
const ACK_MS = 500;
/** Longer than ACK_MS by far, so any reply that waits on an fsync is late every run, not on a loaded runner only. */
const SLOW_FSYNC_MS = 2_000;

/** Inputs a schema can't spell out: which decision a card answers, the answer's id. Everything else is sample(). */
const INPUT: Record<string, unknown> = {
  "follow.brief-action": { agentId: FIXTURE.agentId, briefId: FIXTURE.briefId, decisionId: "D1", choice: "A", answerId: "rpc-ack-answer-1" },
  "follow.answer-question": { workspaceId: FIXTURE.workspaceId, questionId: FIXTURE.questionId, choice: "A", action: "send" },
  // The queue screen's Sweep now starts the sweep and replies; the screen polls the view while it runs.
  "follow.sweep-queue": { wait: false },
};
/** The developer's answers: these must succeed in time, not just fail fast. */
const MUST_SUCCEED = new Set(Object.keys(INPUT));

const EXEMPT: Record<string, string> = {
  // Workspaces and PRs. Nothing changes until the developer confirms, or the change is GitHub's own request.
  "follow.prepare-pr-action": "A merge or reviewer plan reads the PR's live state from GitHub; nothing changes until confirm.",
  "follow.check-pr-action": "Re-checks a PR action against GitHub; read-only.",
  "follow.request-reviewers": "Requests reviewers on GitHub; with Remember on, the list is saved before the request.",
  "follow.reviewer-suggestions": "Suggestions are the repository's collaborators, from GitHub; read-only.",
  "follow.pr-workflow": "Settings → PR workflow resolves each repository's workflow (Graphite or GitHub); read-only.",
  "follow.set-pr-workflow": "Saves the setting, then re-resolves the workflow for the view it returns.",
  // Rename title with AI: the dialog shows "Suggesting a name…" and Try again, and the rename is Paseo's own title.
  "follow.rename-status": "Reads the workspace's name from Paseo and, with suggest, waits on the model; changes nothing but the day's count.",
  "follow.rename-workspace": "Setting Paseo's workspace title is the action; on a timeout the name and the undo ledger stay as they were.",
  // Settings screens: reads, or a toggle saved before the slow part.
  "follow.brief-chat-search": "Settings → Morning brief's person and channel pickers search the chat source through mcpproxy as the developer types; read-only, the picker shows Searching… and keeps the typed query.",
  "follow.project-settings": "The project list comes from Paseo; read-only.",
  "follow.set-project-tracking": "Checks the project against Paseo's list before saving the toggle.",
  "follow.agent-settings": "Settings → Agents reads Paseo's provider catalog (cached ten minutes); read-only.",
  "follow.set-agent-setting": "Saves the role's agent, then returns the view with Paseo's provider catalog.",
  "follow.set-wait": "Saves the switch, then returns the Agents view with Paseo's provider catalog.",
  "follow.onboarding-checks": "Getting started's readiness checks run gh and ask Paseo; read-only.",
  "follow.updates": "Settings → General asks Paseo for this install's source and npm for a newer version; read-only.",
  "follow.set-updates": "Saves the update mode, then returns the view above.",
  // New (docs/dispatch.md): reads while the dialog is open; the dispatch itself records and replies before any create.
  "follow.dispatch-sources": "New's list reads the developer's Linear issues through mcpproxy (one shared read a minute) and Paseo's projects; read-only.",
  "follow.dispatch-preview": "New's preview reads the source (one get_issue, or GitHub) and Paseo's projects; read-only, nothing is created.",
  "follow.dispatch": "Resolves the plan (Paseo's project list, the source) before recording it, so a blocked dispatch is refused, never recorded; the workspace and agent start after the reply.",
  "follow.dispatch-settings": "The Project picker's list comes from Paseo; read-only.",
  "follow.set-dispatch-settings": "Saves the base or rule, then returns the view with Paseo's project names.",
  "follow.dismiss-update-notice": "Dismisses the notice, then returns the view above.",
  "follow.install-update": "Checks the install's source with Paseo before the detached install.",
  "follow.release-notes": "What's new asks Paseo for this install's version and source; read-only.",
  "follow.whats-new-seen": "Marks What's new seen, then returns the view above.",
  // Report a bug (docs/report-issue.md): the sheet shows its own spinner, keeps the typed words on failure, and nothing is filed by these.
  "follow.report-issue-targets": "The sheet's agent picker reads Paseo's agent directory (cached); read-only, the picker shows a spinner meanwhile.",
  "follow.report-issue-send": "Hands the developer's words to an agent through Paseo (or starts one); the sheet keeps the text and shows Not sent on a timeout.",
  "follow.report-issue-link": "Open on GitHub builds the prefilled link with the versions block, asking Paseo for the daemon's version; read-only.",
  "follow.retry-move": "2.0's Try again on the plugin-id move asks Paseo for this install's id and source to see the move failed, records the ask, then returns the view above; the move itself runs after the reply. A timeout loses nothing; one click asks again.",
  // The Overseer. Follow-up: queue the developer's question like brief answers (overseer-ask carries their words).
  "follow.overseer-start": "Starts the Overseer agent through Paseo; its status says starting until it's up.",
  "follow.overseer-restart": "Restarts the Overseer agent through Paseo.",
  "follow.overseer-ask": "Sends the developer's question to the Overseer agent through Paseo. The search box keeps the words unless it succeeds (client/home.tsx).",
};

test("rpc ack: every RPC the client calls replies within ACK_MS while Paseo, the daemon and GitHub hang", { timeout: 180_000 }, async t => {
  const disk = await slowFsync(SLOW_FSYNC_MS);
  t.after(() => disk.undo());
  const host = await hangingHost();
  t.after(() => host.close());
  await seed(host.directory);
  const { default: contribute } = await import("../index.server");
  const { server, handlers } = fakeServer();
  const stop = contribute(server as never) as unknown as () => Promise<void>;
  t.after(() => stop());
  const paseo = hanging();
  const client = await clientRpcs();
  const run = (h: Registered, input: unknown) => async () => h.run(await h.input.parseAsync(input), { paseo });
  // Worker start is its own budget (it may wait on the daemon's connect timeout); the methods are timed after it.
  const started = await settleTime(run(handlers.get("follow.list")!, {}), 60_000);
  assert.ok(started.ms !== null, "the worker never finished starting under a hanging daemon");

  const late: string[] = []; const failed: string[] = []; const stale: string[] = []; const timings: string[] = [];
  const names = [...handlers.keys()].filter(name => client.has(name)).sort();
  assert.ok(names.length >= 40, `found only ${names.length} client RPCs registered; the scan or the harness is broken`);
  for (const name of names) {
    const h = handlers.get(name)!;
    const r = await timeAck(run(h, INPUT[name] ?? sample(h.input)), ACK_MS, host.giveUps);
    timings.push(`${name} ${r.verdict === "late" ? `>${ACK_MS} ms` : `${Math.round(r.ms)} ms${r.verdict === "tainted" ? " (a slow wait gave up meanwhile)" : ""}${r.error ? ` (${r.error.slice(0, 60)})` : ""}`}${r.runs > 1 ? `, ${r.runs} runs` : ""}`);
    if (MUST_SUCCEED.has(name) && r.verdict !== "late" && r.error) failed.push(`${name}: ${r.error}`);
    if (r.verdict === "late" && !EXEMPT[name]) late.push(name);
    if (r.verdict === "fast" && EXEMPT[name]) stale.push(name);
  }
  t.diagnostic(timings.join("\n"));
  assert.deepEqual(Object.keys(EXEMPT).filter(name => !client.has(name) || !handlers.has(name)), [], "EXEMPT lists RPCs the client no longer calls: remove them");
  assert.deepEqual(late, [], `these client RPCs wait on Paseo, the daemon or GitHub before replying. Reply once the work is recorded and run the slow part after (see Inbox.briefAction), or add an EXEMPT entry with the reason`);
  assert.deepEqual(stale, [], "these exempt RPCs now reply in time: remove them from EXEMPT");
  assert.deepEqual(failed, [], "the developer's answers must be recorded, not refused");
});
