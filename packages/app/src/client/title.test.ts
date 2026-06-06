import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_TITLE, titleForHost } from "./title";

describe("titleForHost", () => {
  it("names the selected host so the tab identifies the machine", () => {
    expect(titleForHost("user@host")).toBe("user@host — drishti");
    expect(titleForHost("localhost")).toBe("localhost — drishti");
  });

  it("falls back to the product title for the fleet overview (no host)", () => {
    expect(titleForHost(null)).toBe(APP_TITLE);
  });
});

// `APP_TITLE` is also the static pre-paint `<title>` in index.html — the
// boot/SSR value before `@solidjs/meta`'s reactive `<Title>` takes over on
// mount. index.html can't import TypeScript, so this canary pins the
// hand-authored copy to the constant (mirrors brand.test.ts's HTML canary).
describe("index.html's static title matches APP_TITLE", () => {
  it("keeps the boot title in sync with the constant", () => {
    const html = readFileSync(join(import.meta.dir, "index.html"), "utf8");
    expect(html).toContain(`<title>${APP_TITLE}</title>`);
  });
});
