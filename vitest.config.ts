import { defineConfig } from "vitest/config";

// drishti's unit tests are pure logic (no DOM): the client tests assert over
// colour/metric/url helpers and read static fixtures, the server/agent tests
// drive Node APIs. So the default `node` environment is enough — no jsdom /
// happy-dom (the kolu/odu convention).
//
// The @kolu/* packages are hydrated into node_modules as raw TypeScript
// (scripts/hydrate-kolu-packages.sh), so vite-node must transform them rather
// than treat them as prebuilt — inline them so their `.ts` is compiled on import.
export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts"],
    server: { deps: { inline: [/@kolu\//] } },
  },
});
