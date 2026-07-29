/**
 * W4.5: executed confinement pins — production App.tsx call sites route
 * poll-error and banner visibility ONLY through the pure helpers.
 *
 * Mutating App.tsx to restore raw catch-to-null or wrap the banner in
 * phase==="connected" goes red here (AST/grep over the production file).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appSrc = readFileSync(join(import.meta.dir, "App.tsx"), "utf8");

describe("App.tsx convergence confinement (W4.5)", () => {
  it("poll-error path routes only through applyConvergencePollError", () => {
    expect(appSrc).toMatch(/applyConvergencePollError\s*\(/);
    // No raw catch collapsing convergence to null at the poll site.
    expect(appSrc).not.toMatch(
      /\.catch\s*\(\s*\(\s*\)\s*=>\s*setConvergence\s*\(\s*null\s*\)\s*\)/,
    );
    expect(appSrc).not.toMatch(
      /\.catch\s*\(\s*\(\s*_?\w*\s*\)\s*=>\s*\{\s*setConvergence\s*\(\s*null\s*\)/,
    );
  });

  it("banner visibility comes only from convergenceBannerVisible", () => {
    expect(appSrc).toMatch(/convergenceBannerVisible\s*\(/);
    // No connected-only gate wrapping the banner Show.
    // Forbidden shape: when={phase() === "connected" && convergence...}
    // or when={phase()==="connected" ? convergence() : null}
    expect(appSrc).not.toMatch(
      /phase\s*\(\s*\)\s*===\s*["']connected["']\s*&&\s*convergence/,
    );
    expect(appSrc).not.toMatch(
      /Show\s+when=\{[^}]*phase\s*\(\s*\)\s*===\s*["']connected["'][^}]*convergence/,
    );
    // The banner Show uses the helper directly:
    expect(appSrc).toMatch(
      /Show\s+when=\{convergenceBannerVisible\s*\(\s*convergence\s*\(\s*\)\s*,\s*phase\s*\(\s*\)\s*\)\}/,
    );
  });
});

describe("App.tsx daemon status UI confinement", () => {
  it("polls hosts.daemonStatus and folds via pure helpers", () => {
    expect(appSrc).toMatch(/hosts\.daemonStatus\s*\(/);
    expect(appSrc).toMatch(/applyDaemonStatusOk\s*\(/);
    expect(appSrc).toMatch(/applyDaemonStatusError\s*\(/);
    expect(appSrc).toMatch(/applyRenewResult\s*\(/);
    expect(appSrc).toMatch(/DaemonStatusChip/);
    expect(appSrc).toMatch(/DaemonDialog/);
  });

  it("renew result is state, not only console.error", () => {
    expect(appSrc).toMatch(/setRenewState\s*\(\s*applyRenewResult/);
    // No renew path that only console.errors without setRenewState.
    expect(appSrc).not.toMatch(
      /hosts\.renew[\s\S]{0,200}console\.error\s*\(\s*`renew/,
    );
  });

  it("chip presentation is not inlined as string match on detail", () => {
    // Forbidden: UI parsing anomaly.detail for chip kind.
    expect(appSrc).not.toMatch(/anomaly\.detail\s*\.\s*includes\s*\(/);
    expect(appSrc).not.toMatch(/detail\s*\.\s*startsWith\s*\(/);
  });
});
