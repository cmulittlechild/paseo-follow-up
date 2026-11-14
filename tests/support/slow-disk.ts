import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Makes every fsync in this process take `ms` longer (FileHandle.prototype.sync), until the returned undo runs. A loaded
 * CI runner's fsync took 0.4–1.5 s (2026-11-13/14, rpc-ack); a local disk answers in a few ms, which hid every reply
 * that waited on one. `syncs()` counts the fsyncs started since.
 */
export async function slowFsync(ms: number): Promise<{ undo(): void; syncs(): number }> {
  const probe = join(tmpdir(), `slow-disk-${randomUUID()}`);
  const handle = await open(probe, "w");
  const proto = Object.getPrototypeOf(handle) as { sync(this: unknown): Promise<void> };
  await handle.close(); await import("node:fs/promises").then(fs => fs.unlink(probe)).catch(() => undefined);
  const real = proto.sync;
  let count = 0;
  proto.sync = async function (this: unknown) { count++; await new Promise(r => setTimeout(r, ms)); return real.call(this); };
  return { undo: () => { proto.sync = real; }, syncs: () => count };
}
