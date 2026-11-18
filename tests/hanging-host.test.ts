import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { hangingHost } from "./support/hanging-host";

test("the hanging host counts a peer closing after sending unread handshake bytes", async t => {
  const host = await hangingHost();
  t.after(() => host.close());
  const url = new URL(process.env.PASEO_DAEMON_URL!);
  const peer = connect(Number(url.port), url.hostname);
  t.after(() => { peer.destroy(); });
  await new Promise<void>((resolve, reject) => { peer.once("connect", resolve); peer.once("error", reject); });
  peer.end("GET /ws HTTP/1.1\r\nHost: localhost\r\n\r\n");
  for (let i = 0; i < 50 && host.giveUps() === 0; i++) await sleep(10);
  assert.equal(host.giveUps(), 1, "a disconnected wait must taint RPC timing even when the peer sent bytes");
});
