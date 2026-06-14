import { describe, expect, it } from "vitest";
import { coreUsageColor, processPctColor, usageBarColor } from "./usageColors";

describe("usageBarColor", () => {
  it("is emerald at/under 65, amber above, red above 85", () => {
    expect(usageBarColor(65)).toBe("bg-emerald-500");
    expect(usageBarColor(66)).toBe("bg-amber-500");
    expect(usageBarColor(85)).toBe("bg-amber-500");
    expect(usageBarColor(86)).toBe("bg-red-500");
  });
});

describe("coreUsageColor", () => {
  it("runs hotter — amber above 50, red above 80", () => {
    expect(coreUsageColor(50)).toBe("bg-emerald-500");
    expect(coreUsageColor(51)).toBe("bg-amber-500");
    expect(coreUsageColor(80)).toBe("bg-amber-500");
    expect(coreUsageColor(81)).toBe("bg-red-500");
  });
});

describe("processPctColor", () => {
  it("tints text — neutral, amber above 10, red above 50", () => {
    expect(processPctColor(10)).toBe("text-gray-700 dark:text-gray-400");
    expect(processPctColor(11)).toBe("text-amber-500");
    expect(processPctColor(50)).toBe("text-amber-500");
    expect(processPctColor(51)).toBe("font-semibold text-red-500");
  });
});
