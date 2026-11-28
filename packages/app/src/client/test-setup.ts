/**
 * Bun test preload: happy-dom (for Solid component tests) + Solid JSX transform
 * + the Solid dev-diagnostic gate.
 *
 * happy-dom must install `document` BEFORE any test file imports
 * `@solidjs/testing-library` (its `screen` binds to document.body at import time).
 * We restore Bun's native WebSocket/Event after register so server suites keep working.
 *
 * Two further facts, both loud (kolu's `@kolu/solid-test-setup` shape):
 *
 *   1. **The tests run on Solid's DEVELOPMENT build.** `OBSERVE` is exported
 *      only by `solid-js`'s dev and observe builds, so a config that ever
 *      resolved the production build throws here instead of silently taking
 *      every diagnostic below away.
 *   2. **Any Solid dev diagnostic fails the test that raised it.** Every event
 *      on `OBSERVE.diagnostics` — a strict read in a component body or effect
 *      callback, a write in an owned scope, a cleanup in a forbidden scope,
 *      any code — is collected and thrown from `afterEach`. No code list: a
 *      diagnostic Solid adds later is covered the day it ships.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { transformAsync } from "@babel/core";
// @ts-expect-error - babel preset types are loose
import babelTypeScript from "@babel/preset-typescript";
// @ts-expect-error - the JSX plugin ships no types
import solidBabelPlugin from "@solidjs/babel-plugin";
import { plugin } from "bun";
import { afterEach } from "bun:test";
import { type DiagnosticEvent, OBSERVE } from "solid-js";

const NativeWebSocket = globalThis.WebSocket;
const NativeEvent = globalThis.Event;
const NativeEventTarget = globalThis.EventTarget;
const NativeCloseEvent = globalThis.CloseEvent;
const NativeMessageEvent = globalThis.MessageEvent;
const NativeErrorEvent =
  (globalThis as typeof globalThis & { ErrorEvent?: typeof ErrorEvent })
    .ErrorEvent;

GlobalRegistrator.register();

// GlobalRegistrator replaces transport primitives; put Bun's back for server tests.
if (NativeWebSocket) globalThis.WebSocket = NativeWebSocket;
if (NativeEvent) globalThis.Event = NativeEvent;
if (NativeEventTarget) globalThis.EventTarget = NativeEventTarget;
if (NativeCloseEvent) {
  (
    globalThis as typeof globalThis & { CloseEvent: typeof CloseEvent }
  ).CloseEvent = NativeCloseEvent;
}
if (NativeMessageEvent) {
  (
    globalThis as typeof globalThis & { MessageEvent: typeof MessageEvent }
  ).MessageEvent = NativeMessageEvent;
}
if (NativeErrorEvent) {
  (
    globalThis as typeof globalThis & { ErrorEvent: typeof ErrorEvent }
  ).ErrorEvent = NativeErrorEvent;
}

// Bun's default JSX targets react/jsx-dev-runtime. Client components use
// `@solidjs/web` (tsconfig jsxImportSource) — transform .tsx the same way
// build.ts does, with `dev` on so the compiled components carry the names
// the diagnostic gate below prints in its owner paths.
plugin({
  name: "drishti-solid-test",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const code = await Bun.file(args.path).text();
      const result = await transformAsync(code, {
        filename: args.path,
        plugins: [[solidBabelPlugin, { dev: true }]],
        presets: [[babelTypeScript, {}]],
      });
      if (!result?.code) {
        throw new Error(`Babel transform produced no output for ${args.path}`);
      }
      return { contents: result.code, loader: "js" };
    });
  },
});

if (OBSERVE === undefined) {
  throw new Error(
    "test-setup: solid-js resolved to its PRODUCTION build (OBSERVE is undefined). " +
      "Solid tests must run on the development build, where its diagnostics exist — " +
      "run them through the justfile's `test` recipe (--conditions=browser --conditions=development).",
  );
}

let raised: DiagnosticEvent[] = [];
OBSERVE.diagnostics.subscribe((event) => {
  raised.push(event);
});

afterEach(() => {
  if (raised.length === 0) return;
  const events = raised;
  raised = [];
  throw new Error(
    `Solid raised ${events.length} dev diagnostic(s) during this test:\n` +
      events
        .map(
          (event) =>
            `  [${event.code}] ${event.message}` +
            (event.ownerPath ? `\n    at ${event.ownerPath.join(" › ")}` : "") +
            (event.loc ? `\n    (${event.loc})` : ""),
        )
        .join("\n"),
  );
});
