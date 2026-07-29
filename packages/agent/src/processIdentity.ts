/**
 * osfacts-backed process identity for the agent pid-gate (UW4).
 * Structural twin of surface-daemon's ProcessIdentity — no named export
 * collision with osfacts-client (which returns the anonymous shape).
 */
import { processIdentity as osfactsProcessIdentity } from "osfacts-client";
import type { ProcessIdentity } from "@kolu/surface-daemon";
import { osfactsBinPath } from "./proc";

export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  return osfactsProcessIdentity(osfactsBinPath(), pid);
}

export function selfProcessIdentity(): ProcessIdentity {
  const identity = readProcessIdentity(process.pid);
  if (identity === undefined) {
    throw new Error(
      `osfacts could not resolve this drishti-agent process (${process.pid})`,
    );
  }
  return identity;
}
