/**
 * Compose the dial's own arch probe (`ctx.resolveSystem()`) with the
 * build-time `{system → drvPath}` map drishti bakes in `flake.nix` and
 * threads through `DRISHTI_AGENT_DRVS_JSON`.
 *
 * The probe table and ssh-argv shape now live upstream (juspay/kolu's
 * `surface-remote` package); the only drishti-specific piece left
 * here is the composition — given a host, a map, and the baked
 * binary-cache declaration (`DRISHTI_AGENT_BINARY_CACHE`, from the
 * flake's nixConfig), produce the matching derivation, with a clear
 * error if no entry was baked for the resolved system.
 *
 * The probe comes PRE-BOUND on the connector's context — to this dial's
 * host, signal, progress sink AND its ssh keepalive policy. Calling
 * `resolveSystem(host, { signal, onProgress })` by hand instead would omit
 * the keepalive and open the host's shared `ControlMaster` under the
 * DEFAULT policy while every later command of the same dial asks for the
 * stated one. `host` stays a parameter only to phrase the error below.
 */

import {
  type AgentBinaryCache,
  type AgentDerivation,
  directAgentDerivation,
  type ResolveDrvPathContext,
} from "@kolu/surface-remote";

type HostProbeContext = Pick<ResolveDrvPathContext, "resolveSystem">;

export async function resolveDrvForHost(
  host: string,
  drvBySystem: Readonly<Record<string, string>>,
  binaryCache: AgentBinaryCache,
  context: HostProbeContext,
): Promise<{ derivation: AgentDerivation; system: string }> {
  const sys = await context.resolveSystem();
  const drv = drvBySystem[sys];
  if (drv === undefined) {
    throw new Error(
      `${host}: no agent .drv baked for system=${sys} (known: ${Object.keys(drvBySystem).join(", ")})`,
    );
  }
  return {
    derivation: directAgentDerivation(drv, binaryCache),
    system: sys,
  };
}
