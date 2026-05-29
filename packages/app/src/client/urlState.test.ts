import { describe, expect, it } from "bun:test";
import type { View } from "./view";
import { searchForView, viewFromSearch } from "./urlState";

describe("viewFromSearch", () => {
  it("reads the fleet overview from an empty search", () => {
    expect(viewFromSearch("")).toEqual({ kind: "fleet" });
  });

  it("ignores unrelated params and stays on fleet", () => {
    expect(viewFromSearch("?foo=bar")).toEqual({ kind: "fleet" });
  });

  it("reads a selected host from the host param", () => {
    expect(viewFromSearch("?host=localhost")).toEqual({
      kind: "host",
      host: "localhost",
    });
  });

  it("decodes ssh targets with @ and other reserved chars", () => {
    expect(viewFromSearch("?host=user%40a.lan")).toEqual({
      kind: "host",
      host: "user@a.lan",
    });
  });
});

describe("searchForView", () => {
  it("encodes the fleet overview as the bare path (empty search)", () => {
    expect(searchForView({ kind: "fleet" })).toBe("");
  });

  it("encodes a host into the host param", () => {
    expect(searchForView({ kind: "host", host: "localhost" })).toBe(
      "?host=localhost",
    );
  });

  it("URL-encodes ssh targets so @ survives", () => {
    expect(searchForView({ kind: "host", host: "user@a.lan" })).toBe(
      "?host=user%40a.lan",
    );
  });
});

describe("round-trip", () => {
  it("recovers every view from its own serialization", () => {
    const views: View[] = [
      { kind: "fleet" },
      { kind: "host", host: "localhost" },
      { kind: "host", host: "user@a.lan" },
      { kind: "host", host: "[::1]" },
    ];
    for (const view of views) {
      expect(viewFromSearch(searchForView(view))).toEqual(view);
    }
  });
});
