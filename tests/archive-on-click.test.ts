import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { flatItems, rowMenu, type ArchiveFacts } from "../shared/row-menu";
import { workspace } from "./fixtures";

/**
 * Invariant 6, `follow-up-archives-only-on-the-developer-s-click`: Follow-up never archives a workspace by itself.
 * The row menu's Archive workspace… is the only way it archives one, and only from its confirm step. Every archive
 * call in the plugin's own code is listed here with why it's allowed; a new one (a timer, an auto-archive of merged
 * work, a tool) fails until it's argued for.
 */
const ROOT = join(import.meta.dirname, "..");
const ARCHIVE_CALL = /\b(?:workspaces|workspace)\.archive\(|\barchiveWorkspace\(|"archive_workspace_request"/;
const ALLOWED: Record<string, string> = {
  "client/row-actions.ts": "The row menu's Archive pick, which RowMenu runs only from its confirm step.",
  "server/report-send.ts": "Rolls back the workspace Report an issue created in the same call when its agent can't start.",
};

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...await sources(rel));
    else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/-source\.ts$/.test(e.name)) out.push(rel);
  }
  return out;
}

test("invariant follow-up-archives-only-on-the-developer-s-click: every archive call is allowed by name", async () => {
  const files = [...await sources("client"), ...await sources("server"), ...await sources("shared"), "index.client.tsx", "index.server.ts"];
  const callers: string[] = [];
  for (const f of files) {
    const code = (await readFile(join(ROOT, f), "utf8")).split("\n").filter(l => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    if (ARCHIVE_CALL.test(code)) callers.push(f);
  }
  assert.deepEqual(callers.sort(), Object.keys(ALLOWED).sort(), "a new archive call: Follow-up archives only on the developer's confirmed click");
});

test("the row menu's archive call sits in its own case, and RowMenu runs a confirm item only from the confirm step", async () => {
  const actions = await readFile(join(ROOT, "client", "row-actions.ts"), "utf8");
  const calls = [...actions.matchAll(/archiveWorkspace\(/g)].map(m => m.index!);
  const start = actions.indexOf('case "archive":');
  const end = actions.indexOf("\n      }", start);
  assert.ok(start > 0 && calls.length === 1 && calls[0] > start && calls[0] < end, "archiveWorkspace( is called once, inside case \"archive\"");
  const menu = await readFile(join(ROOT, "client", "row-menu.tsx"), "utf8");
  assert.match(menu, /if \(item\.confirm && confirm\?\.key !== item\.key\) \{ setConfirm\(item\); return; \}/, "the first pick of a confirm item only opens the confirm step");
  const facts: ArchiveFacts = { kind: "worktree", ownedWorktree: true, dirty: true, diff: null, ahead: 1, running: true };
  for (const readyToArchive of [false, true]) for (const w of [workspace(), null]) {
    const item = flatItems(rowMenu({ s: { key: "ws:w", agentId: null, workspaceId: "w", title: "example-app", agent: null, readyToArchive }, flagged: false, w, archive: facts })).find(i => i.action === "archive");
    assert.ok(item?.confirm?.startsWith("Archive example-app?"), "Archive always asks first");
  }
});
