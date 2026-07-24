/**
 * Compose `@kolu/surface-remote`'s `resolveSystem` probe with the
 * build-time `{system → drvPath}` map drishti bakes in `flake.nix` and
 * threads through `DRISHTI_AGENT_DRVS_JSON`.
 *
 * The probe table and ssh-argv shape now live upstream (juspay/kolu's
 * `surface-remote` package); the only drishti-specific piece left
 * here is the composition — given a host and a map, produce the
 * matching drvPath, with a clear error if no entry was baked for the
 * resolved system.
 */

import {
  type AgentDerivation,
  directAgentDerivation,
  type ResolveDrvPathContext,
  resolveSystem,
} from "@kolu/surface-remote";

type HostProbeContext = Pick<
  ResolveDrvPathContext,
  "signal" | "localProgress"
>;

export async function resolveDrvForHost(
  host: string,
  drvBySystem: Readonly<Record<string, string>>,
  context: HostProbeContext,
): Promise<AgentDerivation> {
  const sys = await resolveSystem(host, {
    signal: context.signal,
    onProgress: context.localProgress,
  });
  const drv = drvBySystem[sys];
  if (drv === undefined) {
    throw new Error(
      `${host}: no agent .drv baked for system=${sys} (known: ${Object.keys(drvBySystem).join(", ")})`,
    );
  }
  return directAgentDerivation(drv);
}
