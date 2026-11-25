import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { existsSync, openSync } from "node:fs";
import { join, resolve, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { harness, spawnDaemon, waitUntil } from "./harness.mjs";
import { harnessEnv, harnessConfig, STUBBED_TOOLS } from "./harness-env.mjs";

/**
 * Follow-up on a host without the GitHub CLI (invariant 110, `works-without-github`). Boots an isolated daemon whose
 * PATH has no `gh` at all (`--signed-out`: a `gh` that answers every call like a signed-out CLI and logs each spawn),
 * installs the packed plugin, tracks a workspace with two PRs, and checks what the developer would see: setup doesn't
 * block, the PRs say GitHub isn't connected instead of an error, GitHub-only actions answer in one line, nothing
 * retries gh in the background, and the rest (workspaces, tasks, Needs you) works.
 *
 * `--keep` leaves the daemon running for renders (writes `.preview-isolated.json`, like `npm run preview`).
 */
await harness();
const exec = promisify(execFile);
const signedOut = process.argv.includes("--signed-out");
const keep = process.argv.includes("--keep");
const root = await mkdtemp(join(tmpdir(), "follow-install-nogh-"));
const home = join(root, "home"); const plugin = join(root, "plugin"); const fixture = join(root, "fixture"); const bin = join(root, "bin");
const net = createServer(); await new Promise(r => net.listen(0, "127.0.0.1", r)); const port = net.address().port; await new Promise(r => net.close(r));
const url = `ws://127.0.0.1:${port}/ws`;
let daemon; let client; let api;
const spawns = join(root, "gh-spawns.log");
try {
  await Promise.all([home, plugin, fixture, bin].map(p => mkdir(p, { recursive: true })));
  // A PATH with every host tool but gh: one directory of links to the host's PATH entries, gh left out.
  const farm = join(root, "path");
  await mkdir(farm);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || !existsSync(dir) || dir.startsWith(root)) continue;
    for (const name of await readdir(dir).catch(() => [])) {
      // Stubbed tools stay stubbed (the stub dir comes after this one); gh is left out entirely below.
      if (STUBBED_TOOLS.includes(name) || existsSync(join(farm, name))) continue;
      await symlink(join(dir, name), join(farm, name)).catch(() => undefined);
    }
  }
  if (signedOut) {
    await writeFile(join(bin, "gh"), `#!/bin/sh\necho "gh $*" >> '${spawns}'\necho "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2\nexit 4\n`);
    await chmod(join(bin, "gh"), 0o755);
  }
  await writeFile(spawns, "");
  await writeFile(join(home, "config.json"), JSON.stringify(harnessConfig({ port, webUi: true })));
  const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { timeout: 60000 })).stdout)[0];
  await exec("tar", ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", plugin]);
  await writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "followup-fixture", requirements: { paseo: ">=0.11.0" } }));
  await writeFile(join(fixture, "index.server.ts"), await readFile("scripts/fixture-provider.ts", "utf8"));
  const env = harnessEnv(root, { home, strip: ["GH_TOKEN", "GITHUB_TOKEN", "GH_ACCOUNT_MAP"], set: {
    PASEO_DAEMON_URL: url, PASEO_RELAY_ENABLED: "false", PASEO_WEB_UI_ENABLED: "true",
    PATH: `${bin}${delimiter}${farm}`,
    // The worker's token lookup prefers /usr/bin/gh; point it at this run's gh (or at nothing). Reads would go to
    // FOLLOW_UP_GITHUB_API, which harnessEnv points at a closed port; with GitHub off none is made.
    FOLLOW_UP_GH_BIN: signedOut ? join(bin, "gh") : join(root, "no-such-dir", "gh"),
  } });
  // harnessEnv stubs gh with an exit-127 script; this host has none at all.
  await rm(join(root, ".harness-stubs", "gh"), { force: true });
  const which = await exec("sh", ["-c", "command -v gh || echo none"], { env }).then(r => r.stdout.trim());
  assert.equal(which, signedOut ? join(bin, "gh") : "none", "gh on the daemon's PATH");
  const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", home, "--json", ...args], { env, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout);
  const log = openSync(join(root, "daemon.log"), "a");
  daemon = spawnDaemon(["daemon", "run", "--home", home], { env, stdio: ["ignore", log, log] });
  await waitUntil("isolated daemon did not start", async () => { try { await cli("workspace", "ls"); return true; } catch { assert.equal(daemon.exitCode, null, "isolated daemon exited"); return false; } }, { baseMs: 20_000 });
  await cli("plugin", "install", fixture);
  await cli("plugin", "install", plugin);
  client = new DaemonClient({ url, clientId: "follow-no-gh", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true }); await client.connect(); api = createPaseoApi(client);
  const call = (method, input = {}) => client.invokePluginRpc("follow-up", method, input);
  const w = await api.workspaces.create({ title: "Billing retries", source: { kind: "directory", path: fixture } });
  const agent = await w.agents.create({ config: { provider: "followup-fixture/fixture", model: "fixture", modeId: "default" }, title: "Main agent" });
  await waitUntil("Follow-up did not start", async () => { try { await call("follow.list"); return true; } catch { return false; } }, { baseMs: 30_000 });
  const report = {};
  report.checks = await call("follow.onboarding-checks", { fresh: true });
  report.onboarding = await call("follow.onboarding");
  await call("follow.activate", { workspaceId: w.id }).catch(e => { report.activate = String(e?.message ?? e); });
  await call("follow.enroll", { agentId: agent.id, goal: "Retry failed charges" });
  for (const number of [1, 2]) report[`register${number}`] = await call("follow.register-pr", { agentId: agent.id, repo: "example/app", number, stack: "Retries", parentNumber: number === 1 ? null : 1 }).catch(e => String(e?.message ?? e));
  report.task = await call("follow.obligation", { agentId: agent.id, title: "Backfill failed charges", status: "pending", evidence: "", afterPrs: ["example/app#1"], enable_follow_up: false }).then(() => "ok", e => String(e?.message ?? e));
  await call("follow.refresh", {});
  const window = Number(process.env.NO_GH_WINDOW_MS ?? 90_000);
  const spawnsAtStart = (await readFile(spawns, "utf8")).split("\n").filter(Boolean).length;
  await new Promise(r => setTimeout(r, window));
  const spawnLines = (await readFile(spawns, "utf8")).split("\n").filter(Boolean);
  report.ghSpawnsInWindow = spawnLines.length - spawnsAtStart;
  report.ghSpawnKinds = Object.entries(spawnLines.reduce((m, l) => (m[l.split(" ").slice(0, 3).join(" ")] = (m[l.split(" ").slice(0, 3).join(" ")] ?? 0) + 1, m), {}));
  const record = (await call("follow.get", { workspaceId: w.id })).workspace;
  report.prs = record?.prs.map(p => ({ key: p.key, error: p.error, snapshot: !!p.snapshot }));
  report.githubOff = record?.githubOff ?? null;
  const prKey = record?.prs[0]?.key ?? "example/app#1";
  report.merge = await call("follow.prepare-pr-action", { workspaceId: w.id, prKey, kind: "merge" }).catch(e => `throws: ${e?.message ?? e}`);
  report.reviewers = await call("follow.reviewer-suggestions", { repo: "example/app" }).catch(e => `throws: ${e?.message ?? e}`);
  report.requestReviewers = await call("follow.request-reviewers", { workspaceId: w.id, prKey, reviewers: [{ login: "ravi", kind: "user" }] }).catch(e => `throws: ${e?.message ?? e}`);
  report.waitForChecks = await call("follow.wait-for-checks", { agentId: agent.id }).catch(e => `throws: ${e?.message ?? e}`);
  report.prStats = await call("follow.pr-stats", { repo: "example/app" }).catch(e => `throws: ${e?.message ?? e}`);
  report.dispatch = await call("follow.dispatch-preview", { source: "https://github.com/example/app/issues/9" }).catch(e => `throws: ${e?.message ?? e}`);
  report.inbox = await call("follow.inbox-list", {}).then(r => r.rows.map(x => `${x.kind}: ${x.title ?? x.text ?? ""}`.slice(0, 160)), e => `throws: ${e?.message ?? e}`);
  const daemonLog = await readFile(join(root, "daemon.log"), "utf8");
  report.logLines = daemonLog.split("\n").filter(l => /follow-up/i.test(l) && /gh|github|GitHub|token/i.test(l)).slice(-40);
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  if (process.argv.includes("--report")) console.log(JSON.stringify(report, null, 2));
  console.log(`report: ${join(root, "report.json")}`);
  // works-without-github (invariant 110).
  const off = signedOut ? "signed-out" : "missing";
  const gh = report.checks.checks.find(c => c.id === "gh");
  assert.equal(gh.state, "off", "setup's GitHub row is optional, never a failure");
  assert.equal(report.onboarding.status, "new", "setup isn't blocked");
  assert.equal(report.task, "ok", "tasks work without GitHub");
  assert.equal(report.githubOff, off, "the workspace says why its PRs aren't read");
  for (const p of report.prs) assert.match(p.error ?? "", /^PR status needs GitHub\./);
  assert.match(String(report.merge), /Merging needs GitHub\./);
  assert.match(String(report.requestReviewers), /Adding reviewers needs GitHub\./);
  assert.match(report.reviewers.error ?? "", /^Suggesting reviewers needs GitHub\./);
  assert.deepEqual(report.waitForChecks.waiting, [], "no watch that can never answer");
  assert.match(report.waitForChecks.text, /^Waiting for checks needs GitHub\./);
  assert.equal(report.ghSpawnsInWindow, 0, `nothing retries gh while it is off: ${JSON.stringify(report.ghSpawnKinds)}`);
  assert.deepEqual(report.logLines.filter(l => /read failed|GitHub read/i.test(l)), [], "no GitHub failure logged");
  console.log(`PASS: with gh ${off}, setup is optional, tasks work, every GitHub surface says what's missing in one line, and nothing retries or logs.`);
  if (keep) {
    await writeFile(resolve(".preview-isolated.json"), JSON.stringify({ root, home, port, workspaceId: w.id, agentId: agent.id, daemonPid: daemon.pid }));
    console.log(`Isolated browser app: http://127.0.0.1:${port}; retained for screenshots.`);
    await new Promise(r => { process.once("SIGINT", r); process.once("SIGTERM", r); });
  }
} catch (error) {
  console.error(error.stack);
  const log = await readFile(join(root, "daemon.log"), "utf8").catch(() => ""); console.error(log.slice(-6000));
  process.exitCode = 1;
} finally {
  await api?.dispose().catch(() => undefined); await client?.close().catch(() => undefined);
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM"); await new Promise(r => { const t = setTimeout(() => { daemon.kill("SIGKILL"); r(); }, 5000); daemon.once("exit", () => { clearTimeout(t); r(); }); });
  }
  if (!keep) await rm(root, { recursive: true, force: true });
}
