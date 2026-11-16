import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { undeliveredEntry } from "../server/message-queue";
import { DeliveryDeferred } from "../server/delivery";
import { MESSAGE_STUCK_MS, queueView } from "../shared/queue";
import { needsYou } from "../shared/attention";
import { workspaceHeadline } from "../shared/headline";
import { clock, workspace } from "./fixtures";
import { testQueue } from "./support/queue";

/**
 * A forward or report handed to an agent has no card of its own, so one that doesn't go out (Failed, or Queued past
 * MESSAGE_STUCK_MS) shows in its workspace's Needs you with Retry and Cancel, and leaves once sent or cancelled. Retry
 * and Cancel run the same queue path as follow_queue_action (agent parity).
 */
async function forward(t: { after(fn: () => unknown): void }, o: Parameters<typeof testQueue>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "follow-queue-tools-"));
  const q = await testQueue(root, o);
  q.queue.register("message", { resolve: async item => ({ target: { workspaceId: null, recipients: [item.ref.agentId!] } }), project: async () => {} });
  t.after(async () => { q.queue.stop(); await q.queue.writer.flush().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const item = q.queue.enqueue({ id: "message:helper:m1", kind: "message", key: "workspace", ref: { agentId: "helper" }, messageId: "m1", text: "From the developer via Overseer: ship the fix", priority: "now", state: "queued" });
  return { ...q, item };
}

test("a forward that never left raises Needs you after MESSAGE_STUCK_MS, with the reason, and clears once sent", async t => {
  let up = false;
  const f = await forward(t, { deliver: async target => { if (!up) throw new DeliveryDeferred("Paseo unreachable"); return target.recipients[0]!; } });
  await f.queue.idle();
  const now = Date.parse(f.item.createdAt);
  assert.equal(undeliveredEntry(f.item, now + 60_000, "Billing agent", null), null, "not yet: it is still retrying on its own");
  const entry = undeliveredEntry(f.item, now + MESSAGE_STUCK_MS, "Billing agent", null)!;
  assert.deepEqual({ state: entry.state, reason: entry.reason }, { state: "queued", reason: "Paseo unreachable" });
  const w = workspace({ undelivered: [entry] });
  const items = needsYou(w, clock).filter(i => i.kind === "message");
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "A message to Billing agent didn't go out");
  assert.match(items[0].detail, /Paseo unreachable/);
  assert.equal(workspaceHeadline(items)?.label, "Message not sent");
  // Retry: the same path as follow_queue_action retry.
  up = true; await f.queue.retry(f.item.id); await f.queue.idle();
  assert.equal(f.queue.get(f.item.id)?.state, "sent");
  assert.equal(undeliveredEntry(f.queue.get(f.item.id)!, now + MESSAGE_STUCK_MS * 2, "Billing agent", entry.since), null, "sent: the row clears");
});

test("a Failed forward raises Needs you at once; Cancel drops it and the row clears", async t => {
  const f = await forward(t, { deliver: async () => { throw new Error("connection reset"); }, arrived: async () => null });
  await f.queue.idle();
  for (let i = 0; i < 4 && f.timers.pending.length; i++) { await f.timers.fire(); await f.queue.idle(); }
  const failed = f.queue.get(f.item.id)!;
  assert.equal(failed.state, "failed");
  const entry = undeliveredEntry(failed, Date.parse(failed.createdAt) + 1_000, null, null)!;
  assert.equal(entry.state, "failed");
  assert.equal(needsYou(workspace({ undelivered: [entry] }), clock).find(i => i.kind === "message")?.title, "A message to an agent didn't go out");
  await f.queue.cancel(f.item.id, "Cancelled; it won't be sent.");
  const cancelled = f.queue.get(f.item.id)!;
  assert.equal(queueView(cancelled).state, "cancelled");
  assert.equal(undeliveredEntry(cancelled, Date.now(), null, entry.since), null);
});

test("queueView never carries the message text, only its first line", async t => {
  const f = await forward(t);
  const view = queueView({ ...f.item, text: "From the developer via Overseer: line one\nsecret detail" });
  assert.equal(view.preview, "From the developer via Overseer: line one");
  assert.ok(!JSON.stringify(view).includes("secret detail"));
});

test("a harness time scale shortens the wait before a stuck message shows, like every other queue wait", () => {
  const item = { id: "m", kind: "message", key: "ws", ref: { agentId: "a" }, messageId: "x", text: "t", priority: "now", state: "queued", attempts: 2, unknowns: 0, nextAt: null, reason: "Paseo unreachable", envelope: null, gone: null, to: null, createdAt: "2026-11-16T09:00:00.000Z", settledAt: null } as const;
  const at = Date.parse(item.createdAt) + MESSAGE_STUCK_MS / 4;
  assert.equal(undeliveredEntry(item as never, at, null, null), null);
  assert.ok(undeliveredEntry(item as never, at, null, null, 0.25));
});
