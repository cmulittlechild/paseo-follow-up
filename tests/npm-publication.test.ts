import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("invariant accepted-publish-waits-for-registry: the workflow budgets 45 minutes and gates release notes", async () => {
  const workflow = await readFile(".github/workflows/publish-npm.yml", "utf8");
  const jobMinutes = Number(workflow.match(/timeout-minutes: (\d+)/)?.[1]);
  assert.ok(jobMinutes >= 75, "pre-publish checks must leave a full 45-minute registry window");
  assert.match(workflow, /node "\$RUNNER_TEMP\/publish-npm\.mjs"/);
  const stepMinutes = Number(workflow.match(/name: Publish or verify the existing package\n\s+timeout-minutes: (\d+)/)?.[1]);
  assert.ok(stepMinutes >= 50, "the step itself must leave the full registry window after npm commands");
  assert.match(workflow, /needs: publish/);
  assert.doesNotMatch(workflow, /continue-on-error: true|if:.*always\(/);
});

import { publishPackage, registryJson, VERIFY_TIMEOUT_MS, POLL_INTERVAL_MS } from "../scripts/publish-npm.mjs";

const pkg = { name: "acme-example", version: "1.2.3-beta.0" };
const integrity = "sha512-fixture";
function fixture(visibleAt: number, tagsAt = visibleAt) {
  let clock = 0;
  const calls: string[][] = [];
  const reads: string[] = [];
  const deps = {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    log: () => undefined,
    output: () => undefined,
    npm: (args: string[]) => { calls.push(args); return args[0] === "pack" ? { status: 0, stdout: JSON.stringify([{ integrity }]) } : { status: 0, stdout: `+ ${pkg.name}@${pkg.version}\n` }; },
    read: async (path: string) => {
      reads.push(path);
      if (path.endsWith("/dist-tags")) return clock >= tagsAt ? { beta: pkg.version, latest: "1.2.2" } : { beta: "1.2.2-beta.0" };
      return clock >= visibleAt ? { dist: { integrity } } : null;
    },
  };
  return { deps, calls, reads, time: () => clock };
}

test("an accepted version appearing 25 minutes later is verified without publishing again", async () => {
  const f = fixture(25 * 60_000);
  await publishPackage(pkg, f.deps);
  assert.equal(f.time(), 25 * 60_000);
  assert.equal(f.calls.filter(args => args[0] === "publish").length, 1);
  assert.equal(VERIFY_TIMEOUT_MS, 45 * 60_000);
  assert.equal(POLL_INTERVAL_MS, 15_000);
});

test("integrity visibility does not shorten the dist-tag's 45-minute verification window", async () => {
  const f = fixture(25 * 60_000, 40 * 60_000);
  await publishPackage(pkg, f.deps);
  assert.equal(f.time(), 40 * 60_000);
});

test("accepted publication timeout is distinct from rejection and forbids rewriting the tag", async () => {
  const f = fixture(Infinity);
  await assert.rejects(publishPackage(pkg, f.deps), (error: unknown) => {
    assert.equal((error as { code: string }).code, "NPM_ACCEPTED_NOT_VISIBLE");
    assert.match(String(error), /accepted by npm but is not fully visible yet/);
    assert.match(String(error), /tag must not be rewritten/);
    return true;
  });
  assert.equal(f.time(), VERIFY_TIMEOUT_MS);
  assert.equal(f.calls.filter(args => args[0] === "publish").length, 1);
});

test("an npm acceptance receipt still counts if npm exits nonzero afterwards", async () => {
  const f = fixture(25 * 60_000), npm = f.deps.npm;
  f.deps.npm = args => args[0] === "publish" ? { ...npm(args), status: 1 } : npm(args);
  await publishPackage(pkg, f.deps);
  assert.equal(f.time(), 25 * 60_000);
});

test("a real npm rejection fails immediately, and an unreadable preflight never publishes", async () => {
  const f = fixture(Infinity), npm = f.deps.npm;
  f.deps.npm = args => args[0] === "publish" ? { status: 1, stdout: "", stderr: "authorization denied" } : npm(args);
  await assert.rejects(publishPackage(pkg, f.deps), { code: "NPM_PUBLISH_FAILED" });
  assert.equal(f.time(), 0);
  assert.equal(f.reads.length, 1);
  const g = fixture(Infinity);
  g.deps.read = async () => { throw new Error("Registry GET failed (503)."); };
  await assert.rejects(publishPackage(pkg, g.deps), /503/);
  assert.deepEqual(g.calls.map(args => args[0]), ["pack"]);
});

test("existing matching contents are verified without republishing; different contents fail immediately", async () => {
  const f = fixture(0);
  await publishPackage(pkg, f.deps);
  assert.deepEqual(f.calls.map(args => args[0]), ["pack"]);
  const g = fixture(0);
  g.deps.read = async () => ({ dist: { integrity: "sha512-other" } });
  await assert.rejects(publishPackage(pkg, g.deps), { code: "NPM_CONTENT_MISMATCH" });
  assert.deepEqual(g.calls.map(args => args[0]), ["pack"]);
});

test("transient registry errors after acceptance retry, but a prerelease on latest is refused", async () => {
  const f = fixture(60_000), read = f.deps.read;
  f.deps.read = async path => { if (f.time() > 0 && f.time() < 60_000) throw new Error("Registry GET failed (503)."); return read(path); };
  await publishPackage(pkg, f.deps);
  assert.equal(f.time(), 60_000);
  const g = fixture(0), get = g.deps.read;
  g.deps.read = async path => path.endsWith("/dist-tags") ? { beta: pkg.version, latest: pkg.version } : get(path);
  await assert.rejects(publishPackage(pkg, g.deps), { code: "NPM_PRERELEASE_IS_LATEST" });
});

test("all registry probes bypass cached 404s with revalidation headers and fresh query keys", async () => {
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  let tick = 100;
  const fetcher = (async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    requests.push({ url: String(url), options });
    return new Response(requests.length === 1 ? null : JSON.stringify({ beta: pkg.version }), { status: requests.length === 1 ? 404 : 200 });
  }) as typeof fetch;
  assert.equal(await registryJson(`${pkg.name}/${pkg.version}`, { fetch: fetcher, now: () => tick++ }), null);
  assert.deepEqual(await registryJson(`-/package/${pkg.name}/dist-tags`, { fetch: fetcher, now: () => tick++ }), { beta: pkg.version });
  assert.notEqual(new URL(requests[0].url).search, new URL(requests[1].url).search);
  for (const { options } of requests) {
    assert.equal(new Headers(options?.headers).get("cache-control"), "no-cache");
    assert.equal(new Headers(options?.headers).get("pragma"), "no-cache");
    assert.ok(options?.signal);
  }
});


test("retrying an old tag uses the verifier from the workflow commit, without changing package contents", async t => {
  const workflow = await readFile(".github/workflows/publish-npm.yml", "utf8");
  assert.match(workflow, /PUBLISH_WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/);
  const extract = workflow.split("\n").map(line => line.trim()).find(line => line.startsWith('git show "$PUBLISH_WORKFLOW_SHA:scripts/publish-npm.mjs"'));
  assert.ok(extract);
  const dir = await mkdtemp(join(tmpdir(), "publication-tag-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.com"); git("config", "commit.gpgsign", "false");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "acme-example", version: "1.0.0" }));
  git("add", "."); git("commit", "-qm", "old release without verifier");
  const release = git("rev-parse", "HEAD").trim();
  await mkdir(join(dir, "scripts"));
  const source = await readFile("scripts/publish-npm.mjs", "utf8");
  await writeFile(join(dir, "scripts/publish-npm.mjs"), source);
  git("add", "."); git("commit", "-qm", "workflow with verifier");
  const workflowSha = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "--detach", release);
  const output = join(dir, "runner"); await mkdir(output);
  // Only extract the helper. Never execute its real npm publish entry point in a test.
  execFileSync("bash", ["-c", extract], { cwd: dir, env: { ...process.env, PUBLISH_WORKFLOW_SHA: workflowSha, RUNNER_TEMP: output } });
  assert.equal(await readFile(join(output, "publish-npm.mjs"), "utf8"), source);
  assert.equal(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).version, "1.0.0");
  assert.equal(git("rev-parse", "HEAD").trim(), release);
});

const republishErrors = [
  ["E403 duplicate version", `npm error code E403\nnpm error 403 Forbidden - PUT https://registry.npmjs.org/${pkg.name} - You cannot publish over the previously published versions: ${pkg.version}.\n`],
  ["EPUBLISHCONFLICT", "npm ERR! code EPUBLISHCONFLICT\nnpm ERR! publish fail Cannot publish over existing version.\n"],
  ["JSON EPUBLISHCONFLICT", JSON.stringify({ error: { code: "EPUBLISHCONFLICT", summary: "Cannot publish over existing version." } })],
] as const;

test("retry after an invisible accepted publish waits through npm's previously-published rejection", async t => {
  for (const [label, stderr] of republishErrors) await t.test(label, async () => {
    const f = fixture(25 * 60_000), npm = f.deps.npm;
    f.deps.npm = args => args[0] === "publish" ? { ...npm(args), status: 1, stdout: "", stderr } : npm(args);
    await publishPackage(pkg, f.deps);
    assert.equal(f.time(), 25 * 60_000, "resume registry verification despite no + spec receipt");
    assert.equal(f.calls.filter(args => args[0] === "publish").length, 1);
    assert.ok(f.reads.some(path => path.endsWith("/dist-tags")));
  });
});

test("previously-published rejection still times out as pending and still checks immutable contents", async () => {
  const f = fixture(Infinity), npm = f.deps.npm;
  f.deps.npm = args => args[0] === "publish" ? { ...npm(args), status: 1, stdout: "", stderr: republishErrors[0][1] } : npm(args);
  await assert.rejects(publishPackage(pkg, f.deps), { code: "NPM_ACCEPTED_NOT_VISIBLE" });
  assert.equal(f.time(), VERIFY_TIMEOUT_MS);
  const g = fixture(30_000), run = g.deps.npm, read = g.deps.read;
  g.deps.npm = args => args[0] === "publish" ? { ...run(args), status: 1, stdout: "", stderr: republishErrors[0][1] } : run(args);
  g.deps.read = async path => g.time() >= 30_000 ? { dist: { integrity: "sha512-other" } } : read(path);
  await assert.rejects(publishPackage(pkg, g.deps), { code: "NPM_CONTENT_MISMATCH" });
  assert.equal(g.time(), 30_000);
});

test("generic E403 and a duplicate-version message for another version remain publish failures", async () => {
  for (const stderr of [
    "npm error code E403\nnpm error 403 Forbidden: authorization denied\n",
    "npm error code E403\nnpm error You cannot publish over the previously published versions: 1.2.3-beta.01.\n",
  ]) {
    const f = fixture(Infinity), npm = f.deps.npm;
    f.deps.npm = args => args[0] === "publish" ? { ...npm(args), status: 1, stdout: "", stderr } : npm(args);
    await assert.rejects(publishPackage(pkg, f.deps), { code: "NPM_PUBLISH_FAILED" });
    assert.equal(f.time(), 0);
  }
});
