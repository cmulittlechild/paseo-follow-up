import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptTitleLookup, TranscriptTitleStore, trackedTitleTranscripts } from "../server/transcript-titles";
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
  let discoveries = 0;
  const lookup = new TranscriptTitleLookup({ store, paths: async () => { discoveries++; return paths; }, budget });
  const tick = () => lookup.tick([w], file.workspaces, async titles => { fillLinkedTitles(file, titles); });
  return { file, w, store, lookup, tick, discoveries: () => discoveries };
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
  const reloaded = new TranscriptTitleLookup({ store: new TranscriptTitleStore(dir), paths: async () => [path], budget: 4096 });
  const tick = () => reloaded.tick([s.w], s.file.workspaces, async titles => { fillLinkedTitles(s.file, titles); });
  assert.equal((await tick()).bytes, 0);
  const appended = receipt("Appended plan"); await appendFile(path, appended);
  assert.equal((await tick()).bytes, Buffer.byteLength(appended));
  assert.equal(s.file.workspaces[s.w.id].items[0].title, "Appended plan");
});

test("replaced and truncated files restart their index cursor", async t => {
  const dir = await temp(t), path = join(dir, "session.jsonl");
  await writeFile(path, line([{ type: "text", text: "x".repeat(600) }])); const s = setup(dir, [path], 4096);
  await s.tick();
  const replacement = receipt("Replaced plan"); await writeFile(path + ".new", replacement); await rename(path + ".new", path);
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
