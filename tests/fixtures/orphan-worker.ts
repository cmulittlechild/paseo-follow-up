// A Follow-up worker in its own process, forked with an IPC channel like Paseo's plugin process
// (tests/worker-lock.test.ts). It reports its lock to the parent, then waits; the parent closes the channel.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeServer, hangingHost } from "../support/hanging-host";

const host = await hangingHost();
const { default: contribute } = await import("../../index.server");
contribute(fakeServer().server as never);
const lock = join(host.directory, "worker.lock");
const timer = setInterval(() => {
  let owner = "";
  try { owner = readFileSync(lock, "utf8"); } catch { return; }
  if (owner.startsWith(`${process.pid}:`)) { clearInterval(timer); process.send?.({ lock }); }
}, 50);
