import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  const store = new LinkedStore(dir);
  const service = new LinkedService({ store, sources: { async issue() { return null; }, async teams() { return []; } }, workspaces: async () => [workspace({ id: publisher, artifacts })] });
  await service.note(new Map([["reader", timelineRefs([{ seqStart: 2, item: { type: "assistant_message", text: `See ${URL}` } }])]]));
  assert.equal((await store.read()).workspaces.reader.items[0].title, "Release plan");
});
