import { describe, expect, it } from "bun:test";
import { canRegisterServiceWorker } from "./pwa";

describe("canRegisterServiceWorker", () => {
  it("is true when the API exists and the context is secure", () => {
    expect(canRegisterServiceWorker({ serviceWorker: {} }, true)).toBe(true);
  });

  it("is false on an insecure context, even with the API present", () => {
    // plain-http LAN access — service workers are forbidden, so we skip
    // rather than throw on a registration that can't succeed.
    expect(canRegisterServiceWorker({ serviceWorker: {} }, false)).toBe(false);
  });

  it("is false when the navigator lacks serviceWorker", () => {
    expect(canRegisterServiceWorker({}, true)).toBe(false);
  });

  it("is false when there is no navigator at all", () => {
    expect(canRegisterServiceWorker(undefined, true)).toBe(false);
  });
});
