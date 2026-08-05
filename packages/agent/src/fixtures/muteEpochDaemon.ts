/**
 * Test-only process entry: a daemon from a PREVIOUS protocol epoch, reproduced
 * by its observable behaviour rather than by vendoring an old release.
 *
 * What a previous-epoch daemon actually does, per the juspay/kolu#2101
 * incident, is exactly two things: it holds the rendezvous (socket + pid gate,
 * so it is indistinguishable from a healthy resident by every check that does
 * not speak to it), and when something connects it **accepts and then says
 * nothing** — because it is waiting for a greeting in a protocol nobody speaks
 * any more. That is the whole fixture. It needs no old code to be faithful; the
 * silence IS the presentation.
 *
 * Before the epoch gate, this is the peer that wedged every remote host: the
 * front spliced into it, the parent's RPC client attached, Effect RPC's pinger
 * got no answer, and ~10s later the link died as a generic transport error that
 * classified as "network" and retried forever.
 *
 * Spawn: `bun packages/agent/src/fixtures/muteEpochDaemon.ts`
 */

import { writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { daemonHome } from "@kolu/surface-daemon";
import { selfProcessIdentity } from "../processIdentity";

function log(msg: string): void {
  process.stderr.write(`[mute-epoch-daemon] ${msg}\n`);
}

const home = daemonHome({ app: "drishti", placement: "state" });
// The gate is claimed the same way the real daemon claims it — `pid\tstartUnixUs`
// — because the takeover path this fixture exists to exercise CORROBORATES the
// classified peer against exactly this file before it signals anything. A
// fixture that skipped the gate would be testing the gate-less squatter path
// instead, which is a different arm.
const identity = selfProcessIdentity();

const held: Socket[] = [];
const server = createServer((socket) => {
  // Accept, and say nothing. Ever. Hold the reference so the socket is not
  // collected and the connection stays open — a peer that closed would present
  // as a dead daemon, which is the case that already worked.
  held.push(socket);
  log("accepted a connection — staying mute (previous-epoch presentation)");
});

server.listen(home.socketPath, () => {
  writeFileSync(home.gatePath, `${identity.pid}\t${identity.startUnixUs}\n`, {
    mode: 0o600,
  });
  log(`listening on ${home.socketPath}, gate claimed (pid ${identity.pid})`);
});

// Nothing here ever exits on its own: the point is that the supervisor must
// take this process over. A self-exit would let a broken takeover pass.
