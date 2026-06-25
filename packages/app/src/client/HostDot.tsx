/**
 * `<HostDot>` — drishti's per-host connection dot, single-sourced.
 *
 * Every host indicator (the fleet card, the tab chip, the open-host header) is
 * this ONE component, which is itself a thin skin over the framework's
 * `<HostStatusPip>`: the dot's GREEN is emitted ONLY from the pip's fact-`ready`
 * branch (`gateStatus(health()) === "ready"` over the complete `health()` fact —
 * transport ∧ mirror ∧ sub-errors), so a stale `connection.state === "connected"`
 * cell can no longer paint a green dot over a dead link. That was the #1564 lie
 * one viewer over: drishti's old dots read the raw cell `.state` and colored
 * themselves directly, folding none of the fact.
 *
 * The RICH presentation stays app-local around the dot — the `state` label, the
 * connecting overlay, the failed card — and feeds only the NOT-ready tone here
 * (`failed → red`, else amber). It can't reach the green: that branch reads the
 * fact alone. `state` is still read for the tone/pulse/title, never for green.
 */

import { HostStatusPip } from "@kolu/surface/solid/HostStatusPip";
import type { SurfaceHealth } from "@kolu/surface/solid";
import type { Accessor } from "solid-js";
import type { ConnectionState } from "drishti-common/browser";
import { DOT_HEX, STATE } from "./connectionColors";

export function HostDot(props: {
  /** The host client's complete health fact — the sole source of the green. */
  health: Accessor<SurfaceHealth>;
  /** The mirror cell's state — for the not-ready TONE, pulse, and tooltip only
   *  (never the green, which is fact-gated). */
  state: Accessor<ConnectionState>;
  class?: string;
}) {
  return (
    <HostStatusPip
      health={props.health}
      readyColor={DOT_HEX.connected}
      // Not ready: red for a terminally-`failed` mirror, amber for every other
      // not-ready state (connecting/copying/reconnecting, or a connected mirror
      // with a stale/erroring sub). Structurally can't be the ready green.
      notReadyTone={() =>
        props.state() === "failed" ? DOT_HEX.failed : DOT_HEX.connecting
      }
      // Pulse while working; a terminally-failed mirror sits steady (nothing is
      // happening until the user acts). A ready dot never pulses regardless.
      pulse={props.state() !== "failed"}
      title={STATE[props.state()].label}
      class={props.class}
    />
  );
}
