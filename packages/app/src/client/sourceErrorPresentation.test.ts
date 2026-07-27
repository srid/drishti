import { describe, expect, it } from "bun:test";
import { OsfactsSourceError } from "drishti-common/source-errors";
import { sourceErrorFacts } from "./sourceErrorPresentation";

describe("osfacts source-error presentation", () => {
  it("recovers named source status after a text-only transport boundary", () => {
    const remote = new OsfactsSourceError({
      operation: "host",
      errors: [{ source: "disk", code: "BLIND_OR_EMPTY" }],
    });
    const transported = new Error(`remote agent failed\n${remote.message}\n    at host`);

    expect(sourceErrorFacts([transported])).toEqual([
      { operation: "host", source: "disk", code: "BLIND_OR_EMPTY" },
    ]);
  });
});
