import vm from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { patchRscCjsInteropHelper } from "../packages/vinext/src/plugins/cjs-interop-esmodule.js";

// The helper exactly as @vitejs/plugin-rsc inlines it (src/transforms/cjs.ts).
const UPSTREAM_HELPER =
  'function __cjs_interop__(m) {return m.__cjs_module_runner_transform || "default" in m && Object.keys(m).every((k) => k === "default" || m[k] === m.default[k]) ? m.default : m;}';

function loadHelper(): (m: object) => any {
  const code = patchRscCjsInteropHelper(`let exports = {};\n${UPSTREAM_HELPER}\n"use strict";`);
  if (code === undefined) throw new Error("helper was not patched");
  return vm.runInThisContext(`(() => {\n${code}\nreturn __cjs_interop__;\n})()`);
}

function namespace(exports: Record<string, unknown>): object {
  return Object.freeze(
    Object.assign(Object.create(null), exports, {
      [Symbol.toStringTag]: "Module",
    }),
  );
}

// TypeScript's CommonJS output for `import X from "y"`.
function importDefault(mod: any): any {
  return mod && mod.__esModule ? mod : { default: mod };
}

describe("patchRscCjsInteropHelper", () => {
  it("leaves code without plugin-rsc's helper alone", () => {
    expect(patchRscCjsInteropHelper("module.exports = 1;")).toBeUndefined();
  });

  it("marks an ESM namespace with default and named exports as __esModule (#237)", () => {
    const Script = () => null;
    const required = loadHelper()(namespace({ default: Script, initScriptLoader: () => {} }));
    expect(required.__esModule).toBe(true);
    expect(importDefault(required).default).toBe(Script);
    expect(Object.keys(required)).toEqual(["default", "initScriptLoader"]);
  });

  it("still unwraps .default the way upstream does", () => {
    const moduleExports = { a: 1 };
    const interop = loadHelper();
    expect(
      interop(namespace({ default: moduleExports, __cjs_module_runner_transform: true })),
    ).toBe(moduleExports);
    expect(interop(namespace({ default: moduleExports, a: 1 }))).toBe(moduleExports);
  });

  it("returns a namespace that already says __esModule as is", () => {
    const ns = namespace({ __esModule: true, default: 1, named: 2 });
    expect(loadHelper()(ns)).toBe(ns);
  });
});
