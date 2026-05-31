# The reconnect that wedged, then spun: a debugging story

*How a "3 hosts won't connect" bug report turned into two upstream fixes, one
near-miss whole-server outage, a thenable-proxy footgun, and a side-quest into
a physically degraded CPU — and what each dead-end taught us.*

---

## The report

> *"Look at production drishti and find out why the 3 machines are failing to
> connect despite me being able to ssh to them."*

[drishti](https://github.com/srid/drishti) is htop for your whole fleet:
Browser ↔ a local parent server ↔ a remote agent shipped over `ssh` on first
connect, all on the typed reactive transport
[`@kolu/surface`](https://github.com/juspay/kolu). The screenshot showed five
tabs: `localhost` and `pureintent` green, three others stuck amber — one
frozen mid *"Copying agent to remote…"*.

The obvious suspects — ssh broke, `nix copy` failed, the remote `nix-daemon`
doesn't trust the user — were all wrong. The user could ssh in by hand. So we
went to the logs.

## Lesson 0: logs are a feature, and ours weren't good enough

The first finding wasn't the bug. It was that **we couldn't read our own
logs.** The parent server wrote everything to stderr with no timestamps, and
every host's reconnect "bridge" logged a flat, un-attributed `[bridge]`
prefix. Five hosts' lifecycles interleaved into one indistinguishable stream,
and nothing was on a timeline. You cannot debug a *timing* problem without a
clock.

So before chasing the bug we made the logs diagnostic
([drishti #34](https://github.com/srid/drishti/pull/34)):

- **ISO timestamps** on every line — stamped once, at the sink, so they cover
  the library's lines and the forwarded remote-agent lines too, not just our
  own.
- **Per-host tags** — `[bridge:vanjaram.tail12b27.ts.net]` instead of
  `[bridge]`. (This one was load-bearing: without it the five streams are
  uncorrelatable.)
- **Handoff instrumentation** — a per-spawn `client #N` id, an
  `issuing system.get subscription (client #N)` line, and elapsed-to-first-RPC
  on the first snapshot.
- An agent-side `waiting for first RPC (Ns)…` heartbeat, so an idle
  respawned agent *says so* from the far end.

A nice review-pass detail: we'd reached for a structured logging library
(pino). Two independent reviewers talked us out of it — the problem was *one
concept fragmented five ways*, not missing features, and a JSON logger
wouldn't even cover the third-party library's stderr. A nine-line
`makeLogger(tag)` factory plus sink-level timestamps did the job at zero
dependency cost. *Right-sizing the fix is part of the fix.*

## The diagnosis: the agent was fine; the parent gave up

With readable logs, the picture flipped. Sliced to a single 3-hour server
process:

```
host            first RPC received   handshake timeouts   final state
localhost       1                    0                    connected ✓
pureintent      1                    8                    failed
sincereintent   1                    38                   failed
vanjaram        1                    20                   failed
rasam           1                    20                   failed
```

Every host connected **exactly once**, then every *subsequent* reconnect timed
out. `sincereintent` got copied, realised, started, and printed
`serving surface over stdio` **twenty times** — but `first RPC received` fired
only **once**. The remote side was healthy on every attempt. It was the
**parent** that stopped sending the `system.get` subscription after the first
link drop. `localhost` survived only because its local-stdio link never drops,
so it never needed a reconnect.

The bug lived in the reconnect *bridge handoff*: after a drop, the parent
re-issued `system.get` against the just-exited child's stdio client, and that
RPC **neither answered nor errored** — it hung forever. So
`Promise.allSettled` never resolved, the reconnect loop never advanced, and
every genuinely-respawned agent sat idle until a 30-second watchdog reaped it.
Five strikes → terminal `failed`. **One transient network blip permanently
downed a host.** We watched it happen organically: a single 04:23Z tailscale
hiccup took 3 of 5 hosts to `failed`.

## Fix #1: a dead link must fail fast, not hang

The stdio link is one-shot — bound to a single stream pair, no reconnect by
design. But a request issued *after* its read stream had ended awaited a
response that could never come. That's just wrong.

[kolu #1060](https://github.com/juspay/kolu/pull/1060) added a `closed` latch
to `LinkStdioClient`: once the inbound stream ends, subsequent calls reject
immediately (`SURFACE_STDIO_TRANSPORT_CLOSED`) instead of hanging. A regression
test (live loopback round-trip → end the agent's stdout → assert the next RPC
rejects) timed out at 5s pre-fix and rejected in under a millisecond after.

Clean, tested, reviewed, merged. We bumped drishti to pick it up. The user
deployed it. We killed an agent to watch the fix work.

**The whole server fell over.**

## Lesson 1: fixing a bug can unmask a worse one

Every card — including `localhost`, which has no remote transport to lose —
went to "connecting." The server pegged a CPU core at 70%, and
`curl localhost:7720` returned nothing. The logs told the story, and the
numbers were absurd:

```
13:32:39 [bridge:vanjaram] agent client ready (client #948705); starting pumps
13:32:39 [bridge:vanjaram] issuing system.get subscription (client #948705)
13:32:39 [bridge:vanjaram] system: stream error ... request not sent.   ← the fix, fast-failing
13:32:39 [bridge:vanjaram] pumps ended for client #948705
13:32:39 [bridge:vanjaram] agent client ready (client #948706)          ← next, instantly, no backoff
```

`client #948706`. **Nearly a million reconnect iterations in two minutes**,
every one fast-failing, all stamped the same millisecond — and (the eventual
key clue) **zero session-level events**: no spawn, no `agent exited`, no
`reconnecting in…`. The bridge was looping in pure CPU.

The fix had turned a **hang** into a **spin**. And the spin was *worse*: the
hang downed one host while the server stayed up; the spin pegged the
single-threaded event loop and took the *whole server* unresponsive. The hang
had been acting as an accidental brake. We removed the brake without adding a
real one.

(The good news, buried in the panic: this is exactly what a controlled
kill-test is *for*. We caught a worse regression on a box we'd deliberately
poked, not at 3am from an organic failure.)

## Lesson 2: never assume — reproduce

Here's where it got humbling. Reading the code, the spin was *impossible*. The
consumer loop passed `lastClient` back as `previous`; `waitForNextClient` only
resolves when `client !== previous`; with no new spawn, the client can't
change, so it should *block*. Every armchair trace said "this cannot spin."

The data said it spun two million times.

When the code and reality disagree, reality wins, and you stop theorizing and
**reproduce**. We wrote a faithful test: a real `serveOverStdio` agent over an
in-process stdio pair, mocked `child_process.spawn`, connect → `markConnected`
→ drop the link. And we *instrumented the comparison itself*:

```
[repro] iterations=37143  sameAsPrev=0  samePromise=37142  realSpawns=1  state=connected
```

There it was, in two numbers:

- **`samePromise=37142`** — `session.currentClient()` returned the **same
  Promise object** every iteration. One spawn. The session was static.
- **`sameAsPrev=0`** — yet `waitForNextClient` returned a **different client
  object** every single time.

Awaiting one stable promise, 37,000 times, yielding a different object each
time. That's only possible one way.

## The root cause: a thenable client

The agent client is an **oRPC proxy**. It forwards *every* property access as
a procedure path — including `.then`. That makes it **thenable**. And when you
`await` a promise whose resolved value is itself thenable, JavaScript's
promise-resolution machinery *unwraps it again* — it calls `.then` on the
value. For our proxy, accessing `.then` mints a fresh RPC-shaped object.

So `await session.currentClient()` never returned the client; it returned a
brand-new object every call. `client !== previous` was **always** true.
`waitForNextClient` resolved on *every* iteration.

Why had it never bitten before? Because **the hang was hiding it.** Pre-#1060,
the pump hung, so the consumer loop never looped back to call
`waitForNextClient` a second time. The bug had been sitting there the whole
time, masked by a *different* bug. #1060 removed the mask.

And the spin was self-sustaining in the cruelest way: by pegging the event
loop, it starved the very callbacks — the child `exit` handler, the
reconnect-backoff timer — that would have transitioned the session out of its
stuck state and stopped the loop. The bug ate its own cure. That's why the
production logs showed *zero* session events: those callbacks never got to
run.

## Fix #2: compare the promise, never the client

[kolu #1064](https://github.com/juspay/kolu/pull/1064): key the wait on the
`clientPromise` **reference** — which is reassigned exactly once per spawn and
is `null` between a child's death and the next spawn — instead of the thenable
client. Same-spawn → same promise → the loop *blocks*, freeing the event loop
so `exit` and the backoff timer fire and recovery proceeds.

The review pass added the nicest touch: the raw primitive still let a careless
consumer forget to advance the token and reintroduce the spin, so the fix was
wrapped in a `makeClientCursor(session)` whose `cursor.next()` owns the token
internally. **The footgun isn't just fixed; it's encapsulated out of
existence.** The regression test that did 36,683 iterations pre-fix now blocks
until a real reconnect.

## The verdict, in production

Deploy, then the same kill-test that had taken the server down:

```
14:49:31 [bridge:vanjaram] pumps ended for client #1 — awaiting next client
14:49:31 [host:vanjaram] agent exited (signal=SIGKILL)        ← exit handler fired — event loop free
14:49:31 reconnecting in 2000ms… (attempt 1/5)                ← real backoff
14:49:47 [bridge:vanjaram] agent client ready (client #2)
14:49:50 [bridge:vanjaram] first snapshot → marking connected (client #2, 3235ms)   ← RECOVERED
14:49:50 connection: connecting → connected
```

`client #2`. One clean reconnect. CPU flat the whole time. Two-for-two across
a Linux host and a macOS host. The wedge *and* the spin it had been hiding are
both gone.

## Two side-quests worth their own paragraph

**Sometimes it really is the hardware.** Mid-effort, the kolu CI's `biome` lint
kept dying — `signal 11` one run, `signal 4` the next, no output. We almost
wrote it off as flaky. Instead we reproduced it on the build host and pulled
`dmesg`: **Machine Check Exceptions**, the CPU self-reporting hardware errors,
time-correlated with the crashes. The box was an Intel **i9-14900K** — the
Raptor Lake generation with the well-documented Vmin-shift instability — and
it was *already on the latest mitigation microcode* (`0x132`), so the silicon
was degraded past saving. Nondeterministic `SIGILL`/`SIGSEGV` in a
compute-heavy native binary, on a 14900K, is a fingerprint, not a flake. (The
scarier implication: a miscomputing CPU can return *wrong answers without
crashing* — so we moved the lane off that host rather than trust its green
checks.)

**Your CI is only as reliable as the laptop running it.** We also burned time
on a 1Password SSH agent that went cold after an auto-update (signing the
*first* request after idle failed, the retry succeeded — which silently flaked
a long CI run making hundreds of ssh calls), a config file the runner read
from a *different* path than its docs claimed, an overloaded build host hitting
60s Playwright timeouts, and a disk-full host. None of it was the code. All of
it was real, and recognizing "this is infra, not my diff" quickly is its own
skill.

## What we'd tell ourselves at the start

1. **Invest in logs before you need them.** Timestamps, stable per-entity tags,
   and a sequence id turned an unreadable 3-hour stream into a diagnosis in
   minutes. Structured attribution is a feature, not overhead.
2. **When the code and the logs disagree, reproduce — don't theorize.** Our
   confident armchair trace said the spin was impossible. A 40-line test with
   two counters found the truth in one run.
3. **A fix can unmask a worse bug.** The hang was an accidental brake; removing
   it exposed a CPU-spin that had been latent all along. Always test the
   *recovery* path of a fix under the failure it addresses.
4. **Beware thenables.** Awaiting an object that intercepts `.then` — proxies,
   ORMs, builder APIs — is a quiet footgun. Compare stable handles (the
   promise), not values that re-materialize on access.
5. **Event-loop starvation makes bugs self-sustaining.** A tight async loop can
   strangle the very callbacks meant to end it. Watch for "no events at all" as
   a symptom of a pegged loop, not a quiet system.
6. **Encapsulate footguns out of existence.** The cursor doesn't just fix the
   bug; it removes the shape of code that could ever reintroduce it.
7. **Sometimes it's the hardware, or the agent, or the disk.** Telling "my diff
   is wrong" apart from "the world around my diff is broken" fast is half the
   job.

The original report was "three machines won't connect." The real story was a
latent thenable-identity bug, hidden for who-knows-how-long behind a hang,
flushed into the open by the very fix for that hang, and finally pinned by
refusing to trust anything we hadn't reproduced. Three PRs later, a dropped
host just… reconnects.

---

*Fixes: [kolu #1060](https://github.com/juspay/kolu/pull/1060) (fail-fast stdio
link) · [kolu #1064](https://github.com/juspay/kolu/pull/1064) (cursor /
busy-spin) · [drishti #34](https://github.com/srid/drishti/pull/34) (enriched
logging) · [drishti #35](https://github.com/srid/drishti/pull/35) (the bump
that proved it).*
