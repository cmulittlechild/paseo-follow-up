import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptTitleLookup, TranscriptTitleStore, trackedTitleTranscripts, TITLE_PARK_RECHECK_MS, parseArtifactLine } from "../server/transcript-titles";
import { emptyLinkedFile, noteRefs } from "../shared/linked";
import { fillLinkedTitles } from "../shared/local-titles";
import { workspace } from "./fixtures";
const URL = "https://claude.ai/artifact/example-plan";
const line = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { content } }) + "\n";
const receipt = (title: string, url = URL) => line([{ type: "tool_use", name: "Artifact", id: "call-1", input: { title } }]) + line([{ type: "tool_result", tool_use_id: "call-1", content: `Published page at ${url}` }]);
async function temp(t: any) { const dir = await mkdtemp(join(tmpdir(), "transcript-titles-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function setup(dir: string, paths: string[], budget = 256) {
  const file = emptyLinkedFile(), w = workspace();
  noteRefs(file, w.id, [{ raw: URL, strong: true }], 0);
  const store = new TranscriptTitleStore(dir);
  let discoveries = 0, now = 1000;
  const lookup = new TranscriptTitleLookup({ store, paths: async () => { discoveries++; return paths; }, budget, now: () => now });
  const tick = () => lookup.tick([w], file.workspaces, async titles => { fillLinkedTitles(file, titles); });
  return { file, w, store, lookup, tick, discoveries: () => discoveries, advance: () => { now += TITLE_PARK_RECHECK_MS; } };
}

test("one shared index respects the byte budget and reads every transcript byte once", async t => {
  const dir = await temp(t), path = join(dir, "session.jsonl"), text = line([{ type: "text", text: "x".repeat(600) }]) + receipt("Release plan");
  await writeFile(path, text);
  const s = setup(dir, [path]); let bytes = 0;
  for (let i = 0; i < 20; i++) { const pass = await s.tick(); assert.ok(pass.bytes <= 256); bytes += pass.bytes; if (!pass.bytes) break; }
  assert.equal(s.file.workspaces[s.w.id].items[0].title, "Release plan");
  assert.equal(bytes, Buffer.byteLength(text));
  assert.equal((await s.store.read()).files[path].offset, bytes);
  assert.equal(s.discoveries(), 1);
});

test("completed misses persist offsets; reload and appends read only new bytes", async t => {
  const dir = await temp(t), path = join(dir, "session.jsonl"), initial = line([{ type: "text", text: "No receipt" }]);
  await writeFile(path, initial); const s = setup(dir, [path], 4096);
  assert.equal((await s.tick()).bytes, Buffer.byteLength(initial));
  let now = 1000;
  const reloaded = new TranscriptTitleLookup({ store: new TranscriptTitleStore(dir), paths: async () => [path], budget: 4096, now: () => now });
  const tick = () => reloaded.tick([s.w], s.file.workspaces, async titles => { fillLinkedTitles(s.file, titles); });
  assert.equal((await tick()).bytes, 0);
  const appended = receipt("Appended plan"); await appendFile(path, appended); now += TITLE_PARK_RECHECK_MS;
  assert.equal((await tick()).bytes, Buffer.byteLength(appended));
  assert.equal(s.file.workspaces[s.w.id].items[0].title, "Appended plan");
});

test("replaced and truncated files restart their index cursor", async t => {
  const dir = await temp(t), path = join(dir, "session.jsonl");
  await writeFile(path, line([{ type: "text", text: "x".repeat(600) }])); const s = setup(dir, [path], 4096);
  await s.tick();
  const replacement = receipt("Replaced plan"); await writeFile(path + ".new", replacement); await rename(path + ".new", path); s.advance();
  assert.equal((await s.tick()).bytes, Buffer.byteLength(replacement));
  s.file.workspaces[s.w.id].items[0].title = null;
  await writeFile(path, "{}\n");
  const missing = "https://claude.ai/artifact/still-missing";
  noteRefs(s.file, s.w.id, [{ raw: missing, strong: true }], 0);
  assert.equal((await s.tick()).bytes, 3);
  assert.equal((await s.store.read()).files[path].offset, 3);
});

test("stop when nothing is untitled; an index hit fills another tracked workspace without a scan", async t => {
  const dir = await temp(t), path = join(dir, "publisher.jsonl"); await writeFile(path, receipt("Shared plan"));
  const s = setup(dir, [path], 4096); await s.tick();
  assert.deepEqual(await s.tick(), { bytes: 0, attempted: 0 });
  const other = workspace({ id: "reader" }); noteRefs(s.file, other.id, [{ raw: URL, strong: true }], 0);
  await rm(path);
  assert.deepEqual(await s.lookup.tick([s.w, other], s.file.workspaces, async titles => { fillLinkedTitles(s.file, titles); }), { bytes: 0, attempted: 0 });
  assert.equal(s.file.workspaces.reader.items[0].title, "Shared plan");
  assert.equal(s.discoveries(), 1);
});

test("only agents of tracked workspaces supply transcript files; no daemon or wake calls", async t => {
  const dir = await temp(t), agents = join(dir, "agents", "acme-app"), projects = join(dir, "claude", "projects", "acme-app");
  await mkdir(agents, { recursive: true }); await mkdir(projects, { recursive: true }); const w = workspace();
  for (const [id, workspaceId] of [["old-root", w.id], ["foreign-root", "untracked"]]) {
    await writeFile(join(agents, id + ".json"), JSON.stringify({ id, workspaceId, provider: "claude", cwd: "/scratch/acme-app", persistence: { sessionId: id } }));
    await writeFile(join(projects, id + ".jsonl"), receipt("Plan"));
  }
  assert.deepEqual(await trackedTitleTranscripts(dir, [w], { claude: join(dir, "claude") }), [join(projects, "old-root.jsonl")]);
});

test("a receipt spanning an append and worker reload keeps only its pending input", async t => {
  const dir = await temp(t), path = join(dir, "session.jsonl");
  const parts = receipt("Resumed plan").split("\n");
  await writeFile(path, parts[0] + "\n"); const s = setup(dir, [path], 4096); await s.tick();
  const next = new TranscriptTitleLookup({ store: new TranscriptTitleStore(dir), paths: async () => [path], budget: 4096 });
  await appendFile(path, parts[1] + "\n");
  const pass = await next.tick([s.w], s.file.workspaces, async titles => { fillLinkedTitles(s.file, titles); });
  assert.equal(pass.bytes, Buffer.byteLength(parts[1] + "\n"));
  assert.equal(s.file.workspaces[s.w.id].items[0].title, "Resumed plan");
});

test("untitled-link workspaces precede other tracked transcripts, newest first within each group", async t => {
  const { utimes } = await import("node:fs/promises");
  const dir = await temp(t), agents = join(dir, "agents", "acme-app"), projects = join(dir, "claude", "projects", "acme-app");
  await mkdir(agents, { recursive: true }); await mkdir(projects, { recursive: true });
  const priority = workspace({ id: "needs-title" }), other = workspace({ id: "other" });
  for (const [id, workspaceId, time] of [["priority-old", priority.id, 10], ["priority-new", priority.id, 20], ["other-new", other.id, 30], ["other-old", other.id, 5]] as const) {
    await writeFile(join(agents, id + ".json"), JSON.stringify({ id, workspaceId, provider: "claude", cwd: "/scratch/acme-app", persistence: { sessionId: id } }));
    const path = join(projects, id + ".jsonl"); await writeFile(path, "{}\n"); await utimes(path, time, time);
  }
  assert.deepEqual((await trackedTitleTranscripts(dir, [priority, other], { claude: join(dir, "claude") }, new Set([priority.id]))).map(p => p.split("/").at(-1)), ["priority-new.jsonl", "priority-old.jsonl", "other-new.jsonl", "other-old.jsonl"]);
});

for (const wake of ["link", "scope", "timer"] as const) test(`caught-up misses park without filesystem work until ${wake} wakes them`, async t => {
  const { stat } = await import("node:fs/promises");
  const dir = await temp(t), path = join(dir, "session.jsonl"); await writeFile(path, line([{ type: "text", text: "No receipt" }]));
  const s = setup(dir, [path], 4096); let now = 1000, stats = 0, metadataPasses = 0, cacheReads = 0;
  const read = s.store.read.bind(s.store); s.store.read = async () => { cacheReads++; return read(); };
  const lookup = new TranscriptTitleLookup({ store: s.store, paths: async () => { metadataPasses++; return [path]; }, now: () => now, statFile: (async (...args: Parameters<typeof stat>) => { stats++; return stat(...args); }) as typeof stat });
  let workspaces = [s.w]; const tick = () => lookup.tick(workspaces, s.file.workspaces, async titles => { fillLinkedTitles(s.file, titles); });
  await tick(); stats = 0; metadataPasses = 0; cacheReads = 0;
  for (let i = 0; i < 10; i++) { now += 30_000; assert.deepEqual(await tick(), { bytes: 0, attempted: 0 }); }
  assert.deepEqual({ stats, metadataPasses, cacheReads }, { stats: 0, metadataPasses: 0, cacheReads: 0 }, "parked ticks do not stat transcripts/cache or rediscover/read agent metadata");
  const appended = receipt("Newly learned plan"); await appendFile(path, appended);
  if (wake === "link") noteRefs(s.file, s.w.id, [{ raw: URL + "-new", strong: true }], now);
  if (wake === "scope") workspaces = [s.w, workspace({ id: "new-scope" })];
  if (wake === "timer") now += TITLE_PARK_RECHECK_MS;
  assert.equal((await tick()).bytes, Buffer.byteLength(appended));
  assert.equal(metadataPasses, 1); assert.ok(stats > 0); assert.ok(cacheReads > 0);
  assert.equal(s.file.workspaces[s.w.id].items[0].title, "Newly learned plan");
});

test("the byte prefilter skips giant non-artifact lines before decoding or parsing", () => {
  const giant = Buffer.from(line([{ type: "text", text: "x".repeat(600000) }]));
  giant.toString = () => { throw new Error("ordinary transcript prose must not be decoded"); };
  assert.equal(parseArtifactLine(giant), null);
});

test("filtered and unfiltered parsing produce the same receipt index across chunk edges", async t => {
  const dir = await temp(t), path = join(dir, "session.jsonl");
  await writeFile(path, line([{ type: "text", text: "x".repeat(600000) }]) + receipt("Split receipt plan") + receipt("Another plan", URL + "-other"));
  const indexes = [];
  for (const filtered of [true, false]) {
    const directory = join(dir, filtered ? "filtered" : "unfiltered"); await mkdir(directory);
    const s = setup(directory, [path], 100003);
    noteRefs(s.file, s.w.id, [{ raw: URL + "-missing", strong: true }], 0);
    const lookup = new TranscriptTitleLookup({ store: s.store, paths: async () => [path], budget: 100003, ...(!filtered ? { parseLine: (buffer: Buffer) => { try { return JSON.parse(buffer.toString("utf8")); } catch { return null; } } } : {}) });
    for (let i = 0; i < 20; i++) if (!(await lookup.tick([s.w], s.file.workspaces, async titles => { fillLinkedTitles(s.file, titles); })).bytes) break;
    assert.equal(s.file.workspaces[s.w.id].items[0].title, "Split receipt plan"); indexes.push((await s.store.read()).titles);
  }
  assert.deepEqual(indexes[0], indexes[1]);
});
