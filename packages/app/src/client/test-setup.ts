/**
 * Bun test preload: happy-dom (for Solid component tests) + Solid JSX transform.
 *
 * happy-dom must install `document` BEFORE any test file imports
 * `@solidjs/testing-library` (its `screen` binds to document.body at import time).
 * We restore Bun's native WebSocket/Event after register so server suites keep working.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { transformAsync } from "@babel/core";
// @ts-expect-error - babel preset types are loose
import babelTypeScript from "@babel/preset-typescript";
// @ts-expect-error - babel preset types are loose
import babelSolid from "babel-preset-solid";
import { plugin } from "bun";

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
// solid-js (tsconfig jsxImportSource) — transform .tsx the same way build.ts does.
plugin({
  name: "drishti-solid-test",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const code = await Bun.file(args.path).text();
      const result = await transformAsync(code, {
        filename: args.path,
        presets: [
          [babelSolid, {}],
          [babelTypeScript, {}],
        ],
      });
      if (!result?.code) {
        throw new Error(`Babel transform produced no output for ${args.path}`);
      }
      return { contents: result.code, loader: "js" };
    });
  },
});
