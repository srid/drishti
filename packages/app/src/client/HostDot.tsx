/**
 * `<HostDot>` — drishti's per-host connection dot, single-sourced.
 *
 * Every host indicator (the fleet card, the tab chip, the open-host header)
 * is this ONE component, colored from the `@kolu/surface-map` `EntryState`
 * FACT (`entry.state()`) — `connectSurfaceMap` floors that fact on real
 * transport liveness (see its README), so a stale cell can no longer paint
 * a green dot over a dead link.
 *
 * This used to wrap the framework `<HostStatusPip>` over a per-host
 * `SurfaceHealth` (`app.health()`); that per-host health fact no longer
 * exists — every host's data now rides the ONE admin transport instead of
 * its own socket, key-folded through the host map. `EntryState` plays the
 * same "is this ready, and what tone if not" role `SurfaceHealth` used to,
 * so this is a straight substitution, not a downgrade: kolu's own host-map
 * chip (`hostChipTone.ts`) makes the identical trade.
 *
 * The tone/pulse/title logic lives in the THIN seam
 * (`entryStatusTone.ts`) — this component is pure presentation over it.
 */

import type { EntryState } from "@kolu/surface-map";
import type { Accessor } from "solid-js";
import { dotClass, statusPending, statusTitle } from "./entryStatusTone";

export function HostDot(props: {
  state: Accessor<EntryState>;
  class?: string;
}) {
  return (
    <span
      class={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${dotClass(props.state())} ${statusPending(props.state()) ? "animate-pulse" : ""} ${props.class ?? ""}`}
      title={statusTitle(props.state())}
      aria-hidden="true"
    />
  );
}
