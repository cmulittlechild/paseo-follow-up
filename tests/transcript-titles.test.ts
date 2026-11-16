import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTitleWindow, TranscriptTitleLookup, TranscriptTitleStore, TITLE_MISS_RETRY_MS, titleTranscriptPaths } from "../server/transcript-titles";
import { emptyLinkedFile, noteRefs } from "../shared/linked";
import { workspace } from "./fixtures";
const URL = "https://claude.ai/artifact/example-plan";
const line = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { content } }) + "\n";
const use = line([{ type: "tool_use", name: "Artifact", id: "call-1", input: { title: "Release plan" } }]);
const result = line([{ type: "tool_result", tool_use_id: "call-1", content: `Published page at ${URL}` }]);
async function temp(t: any) { const dir = await mkdtemp(join(tmpdir(), "transcript-titles-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const cursor = (path: string) => ({ paths: [path], file: 0, offset: 0, dropping: false, pending: {}, retryAt: 0, title: null, rank: 0 });

test("streaming scan stays within its byte budget and pairs receipts across passes", async t => {
  const dir = await temp(t), path = join(dir, "session.jsonl");
  await writeFile(path, use + line([{ type: "text", text: "x".repeat(600) }]) + result);
  let state = cursor(path), evidence = null, windows = 0;
  while (state.file < state.paths.length && !evidence && windows++ < 12) {
    const pass = await scanTitleWindow(URL, state, 256);
    assert.ok(pass.bytes <= 256);
    state = pass.state; evidence = pass.evidence;
  }
  assert.ok(windows > 1);
  assert.deepEqual(evidence, { title: "Release plan", rank: 4 });
  assert.equal(await import("../server/transcript-titles").then(m => m.scanTitleWindow(URL, cursor(join(dir, "missing")), 256)).then(r => r.bytes), 0);
});

test("negative cache survives reload and skips reads until its long retry interval", async t => {
  const dir = await temp(t), path = join(dir, "session.jsonl");
  await writeFile(path, line([{ type: "text", text: "No artifact receipt" }]));
  const file = emptyLinkedFile(), w = workspace();
  noteRefs(file, w.id, [{ raw: URL, strong: true }, { raw: URL + "-other", strong: true }], 0);
  let paths = 0, now = 1000, found = 0;
  const deps = { store: new TranscriptTitleStore(dir), paths: async () => { paths++; return [path]; }, now: () => now };
  assert.equal((await new TranscriptTitleLookup(deps).tick([w], file.workspaces, async () => { found++; })).attempted, 1);
  file.workspaces[w.id].items.pop();
  assert.deepEqual(await new TranscriptTitleLookup({ ...deps, store: new TranscriptTitleStore(dir) }).tick([w], file.workspaces, async () => { found++; }), { bytes: 0, attempted: 0 });
  assert.equal(paths, 1);
  now += TITLE_MISS_RETRY_MS + 1;
  assert.equal((await new TranscriptTitleLookup(deps).tick([w], file.workspaces, async () => { found++; })).attempted, 1);
  assert.equal(paths, 2); assert.equal(found, 0);
});

test("one item per tick; cached success titles links without rereading transcripts", async t => {
  const dir = await temp(t), path = join(dir, "session.jsonl");
  await writeFile(path, use + result);
  const file = emptyLinkedFile(), w = workspace();
  noteRefs(file, w.id, [{ raw: URL, strong: true }, { raw: URL + "-other", strong: true }], 0);
  let paths = 0;
  const lookup = new TranscriptTitleLookup({ store: new TranscriptTitleStore(dir), paths: async () => { paths++; return [path]; } });
  let found = 0;
  const first = await lookup.tick([w], file.workspaces, async () => { found++; });
  assert.equal(first.attempted, 1); assert.equal(found, 1);
  await rm(path);
  assert.deepEqual(await lookup.tick([w], file.workspaces, async () => { found++; }), { bytes: 0, attempted: 1 });
  assert.equal(paths, 1); assert.equal(found, 2);
});

test("only workspace-owned and recorded publisher transcripts are eligible; no daemon or wake calls", async t => {
  const dir = await temp(t), agents = join(dir, "agents", "acme-app"), projects = join(dir, "claude", "projects", "acme-app");
  await mkdir(agents, { recursive: true }); await mkdir(projects, { recursive: true });
  const w = workspace();
  for (const [id, workspaceId] of [["old-root", w.id], ["foreign-root", "another-workspace"]]) {
    await writeFile(join(agents, id + ".json"), JSON.stringify({ id, workspaceId, provider: "claude", cwd: "/scratch/acme-app", persistence: { sessionId: id } }));
    await writeFile(join(projects, id + ".jsonl"), use + result);
  }
  const roots = { claude: join(dir, "claude") };
  assert.deepEqual(await titleTranscriptPaths(dir, w, { by: null }, roots), [join(projects, "old-root.jsonl")]);
  assert.deepEqual(await titleTranscriptPaths(dir, w, { by: "foreign-root" }, roots), [join(projects, "old-root.jsonl"), join(projects, "foreign-root.jsonl")]);
});
