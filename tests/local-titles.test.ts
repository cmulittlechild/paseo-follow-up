import { testStore, rm } from "./support/store-temp-dir";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkedService, LinkedStore } from "../server/linked";
import { timelineRefs } from "../shared/linked-extract";
import { publishedArtifacts } from "../server/spec";
import { workspace } from "./fixtures";

const URL = "https://claude.ai/artifact/example-page";
const receipt = (input: unknown, output: unknown) => ({ timestamp: "2026-11-16T08:00:00Z", seqStart: 1, item: { type: "tool_call", name: "Artifact", status: "completed", detail: { input, output } } });
for (const publisher of ["reader", "another-workspace"]) test(`prose links inherit publish titles from ${publisher}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "local-titles-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const artifacts = publishedArtifacts([receipt({ title: "Release plan" }, `Published page at ${URL}`)], "main-agent");
  const store = testStore(LinkedStore, dir);
  const service = new LinkedService({ store, sources: { async issue() { return null; }, async teams() { return []; } }, workspaces: async () => [workspace({ id: publisher, artifacts })] });
  await service.note(new Map([["reader", timelineRefs([{ seqStart: 2, item: { type: "assistant_message", text: `See ${URL}` } }])]]));
  assert.equal((await store.read()).workspaces.reader.items[0].title, "Release plan");
});

import { writeFile } from "node:fs/promises";
import { receiptTitles, readTitleHtml, TITLE_READ_BYTES } from "../server/local-titles";
import { fillLinkedTitles, fillWorkspaceTitles, localTitles, receiptTitle, titleKey } from "../shared/local-titles";
import { emptyLinkedFile, noteRefs } from "../shared/linked";
import { mergeArtifacts } from "../server/spec";

test("resolver orders explicit title, bounded HTML title, description, basename", async t => {
  const dir = await mkdtemp(join(tmpdir(), "title-html-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "release-plan.html");
  await writeFile(path, '<html><title>Release &amp; rollout &#x1F680;</title>' + 'x'.repeat(20000));
  const html = await readTitleHtml(path);
  assert.equal(Buffer.byteLength(html!), TITLE_READ_BYTES);
  const input = { title: "Explicit", file_path: path, description: "Description" };
  assert.deepEqual(receiptTitle(input, html), { title: "Explicit", rank: 4 });
  assert.deepEqual(receiptTitle({ ...input, title: " " }, html), { title: "Release & rollout 🚀", rank: 3 });
  assert.deepEqual(receiptTitle({ file_path: path, description: "Description" }), { title: "Description", rank: 2 });
  assert.deepEqual(receiptTitle({ file_path: path }), { title: "Release plan", rank: 1 });
  assert.equal(receiptTitle({ file_path: "/scratch/index.html" }), null);
  assert.equal(await readTitleHtml(join(dir, "missing.html")), null);
  assert.equal(await readTitleHtml(dir), null);
  await writeFile(path, 'x'.repeat(TITLE_READ_BYTES) + '<title>Too late</title>');
  assert.deepEqual(receiptTitle({ file_path: path }, await readTitleHtml(path)), { title: "Release plan", rank: 1 });
  const entries = [receipt({ file_path: path, description: "Description" }, `Published page at ${URL}`)];
  assert.equal((await receiptTitles(entries, async () => { throw new Error("gone"); })).get(titleKey(URL))?.title, "Description");
  let reads = 0;
  await receiptTitles([receipt(input, `Published page at ${URL}`)], async () => { reads++; return html; });
  assert.equal(reads, 0, "an explicit title needs no file access");
});

test("publish and read output survives projection as strings, MCP blocks and structured read.result", async () => {
  const titles = await receiptTitles([
    receipt({ file_path: "/scratch/release-plan.html", description: "Description" }, [{ type: "text", text: `Published page at ${URL}` }]),
    receipt({ action: "read", url: URL }, { read: { url: URL, result: "<title>Read page title</title>" } }),
  ], async () => '<title>Published page title</title>');
  assert.equal(titles.get(titleKey(URL))?.title, "Published page title", "equal evidence keeps the first name");
  assert.equal(publishedArtifacts([receipt({}, `Published page at ${URL}`)], "agent", titles)[0].title, "Published page title");
  for (const output of ['Title: Read summary', [{ type: "text", text: '<title>Read HTML</title>' }], { title: "Structured name" }]) {
    assert.ok((await receiptTitles([receipt({ action: "read", url: URL }, output)])).get(titleKey(URL))?.title);
  }
  assert.equal((await receiptTitles([{ item: { ...receipt({ title: "Failed" }, `Published page at ${URL}`).item, status: "failed" } }])).size, 0);
  assert.equal((await receiptTitles([receipt({ action: "list" }, '<title>Never</title>')])).size, 0);
});

test("backfill is idempotent, fills late titles across workspaces, and never overwrites chosen names", async t => {
  const dir = await mkdtemp(join(tmpdir(), "title-backfill-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = testStore(LinkedStore, dir);
  const w = workspace();
  const service = new LinkedService({ store, workspaces: async () => [w], sources: { async issue() { return null; }, async teams() { return []; } } });
  await service.note(new Map([["reader", [{ raw: URL, strong: false }]]]));
  assert.equal((await store.read()).workspaces.reader.items[0].title, null);
  w.artifacts = publishedArtifacts([receipt({ title: "Known later" }, `Published page at ${URL}`)], "agent");
  assert.equal(await service.backfill(), 1);
  assert.equal(await service.backfill(), 0);
  for (const origin of ["manual", "registered"] as const) {
    await service.link("reader", URL, { origin, by: "agent", title: "Chosen name" });
    await service.note(new Map([["publisher", [{ raw: URL, strong: true, title: "Receipt name" }]]]));
    assert.equal((await store.read()).workspaces.reader.items[0].title, "Chosen name");
  }
  const spec = workspace({ spec: { url: URL, title: null, source: "agent", by: "agent", at: "2026-11-16" } });
  const titles = localTitles([w]);
  assert.equal(fillWorkspaceTitles(spec, titles), true);
  assert.equal(spec.spec?.title, "Known later");
  assert.equal(fillWorkspaceTitles(spec, titles), false);
  spec.spec!.title = "Chosen spec";
  fillWorkspaceTitles(spec, titles);
  assert.equal(spec.spec?.title, "Chosen spec");
  mergeArtifacts(w, publishedArtifacts([receipt({}, `Published page at ${URL}`)], "agent"));
  assert.equal(w.artifacts[0].title, "Known later", "a titleless rescan never erases evidence");
});

test("Claude Docs create receipts share their names with prose links; failed operations do not", async () => {
  const url = "https://claude.ai/docs/example-document";
  const entry = { item: { type: "tool_call", name: "mcp__claude_ai_Claude_Docs__batch", status: "completed", detail: {
    input: { batch: [{ verb: "create", object: "container", payload: { name: "Rollout notes" } }] },
    output: [{ type: "text", text: JSON.stringify({ results: [{ url }] }) }],
  } } };
  const titles = await receiptTitles([entry]);
  const file = emptyLinkedFile();
  noteRefs(file, "reader", timelineRefs([{ seqStart: 1, item: { type: "assistant_message", text: url } }]), Date.now());
  assert.equal(fillLinkedTitles(file, titles), 1);
  assert.equal(file.workspaces.reader.items[0].kind, "doc");
  assert.equal(file.workspaces.reader.items[0].title, "Rollout notes");
  entry.item.detail.output[0].text = JSON.stringify({ results: [{ error: "failed", url }] });
  assert.equal((await receiptTitles([entry])).size, 0);
});

import { violations } from "../shared/status-invariants";
import { linkedRow } from "../shared/linked-display";
test("invariant catches a spec that drops a locally known title", () => {
  const w = workspace({ artifacts: publishedArtifacts([receipt({ title: "Release plan" }, `Published page at ${URL}`)], "agent"), spec: { url: URL, title: null, source: "agent", by: "agent", at: "2026-11-16" } });
  assert.ok(violations(w, Date.now()).some(v => v.id === "a-linked-item-uses-every-known-local-title"));
  fillWorkspaceTitles(w, localTitles([w]));
  assert.ok(!violations(w, Date.now()).some(v => v.id === "a-linked-item-uses-every-known-local-title"));
});
test("unnamed artifact rows say where and when they were mentioned", () => {
  const file = emptyLinkedFile();
  noteRefs(file, "reader", [{ raw: URL, strong: false }], Date.parse("2026-11-16T08:00:00Z"));
  const copy = linkedRow({ ...file.workspaces.reader.items[0], spec: false }, "agent");
  assert.equal(copy.title, "Claude artifact");
  assert.equal(copy.meta, "Mentioned in this workspace · Nov 16");
});

test("multiple root receipts retain the strongest evidence regardless of scan order", () => {
  for (const reverse of [false, true]) {
    const w = workspace();
    const artifacts = [
      { ...publishedArtifacts([receipt({ file_path: "/scratch/release-plan.html" }, `Published page at ${URL}`)], "helper")[0], titleRank: 1 },
      { ...publishedArtifacts([receipt({ title: "Explicit receipt title" }, `Published page at ${URL}`)], "main-agent")[0], titleRank: 4 },
    ];
    mergeArtifacts(w, reverse ? artifacts.reverse() : artifacts);
    assert.equal(w.artifacts[0].title, "Explicit receipt title");
    assert.equal(w.artifacts[0].titleRank, 4);
    assert.equal(w.spec?.title, "Explicit receipt title");
  }
});

test("an explicitly named link fills existing unnamed links in other workspaces immediately", async t => {
  const dir = await mkdtemp(join(tmpdir(), "title-explicit-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = testStore(LinkedStore, dir), service = new LinkedService({ store, sources: { async issue() { return null; }, async teams() { return []; } } });
  await service.note(new Map([["reader", [{ raw: URL, strong: false }]]]));
  await service.link("publisher", URL, { origin: "registered", by: "agent", title: "Chosen page name" });
  assert.equal((await store.read()).workspaces.reader.items[0].title, "Chosen page name");
});
