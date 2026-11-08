import type { Plugin } from "vite";

/**
 * The `require()` interop helper `@vitejs/plugin-rsc` inlines, on one line,
 * into every non-optimized CommonJS dependency it rewrites for the dev module
 * runner (`cjs-module-runner-transform`).
 */
const RSC_CJS_INTEROP_HELPER_RE = /^function __cjs_interop__\(m\) \{.*\}$/m;

/**
 * Drop-in replacement for that helper. The first branch is the upstream
 * helper unchanged. The second marks a genuine ESM namespace the way a
 * bundler's ESM-to-CJS interop does (Rolldown's `__toCommonJS` in our
 * production build, webpack in Next.js): a live view of the exports plus
 * `__esModule: true`.
 *
 * Why: TypeScript and Babel compile `import X from "y"` in CommonJS to
 * `__importDefault(require("y")).default`, which takes `.default` only when
 * the required module says `__esModule`. Upstream returns the bare namespace,
 * which has no `__esModule`, so the helper wraps it as `{ default: namespace }`
 * and the consumer renders the namespace object itself as a component. With
 * an ESM shim such as `next/script`, that is the "Only plain objects ...
 * [..., Module, ...]" RSC error of #237, while the production build works.
 * Next.js's own client module proxy answers `__esModule: true` for the same
 * reason.
 *
 * `Reflect.ownKeys` rather than `Object.keys`: reading the namespace's own
 * property descriptors throws on bindings still in their TDZ (circular
 * requires), and the getters defer every read to the require site's use.
 */
const VINEXT_CJS_INTEROP_HELPER =
  "function __cjs_interop__(m) {" +
  'if (m.__cjs_module_runner_transform || "default" in m && Object.keys(m).every((k) => k === "default" || m[k] === m.default[k])) return m.default;' +
  "if (m.__esModule) return m;" +
  "const cjs = {};" +
  'for (const k of Reflect.ownKeys(m)) if (typeof k === "string") Object.defineProperty(cjs, k, { enumerable: true, get: () => m[k] });' +
  'Object.defineProperty(cjs, "__esModule", { value: true });' +
  "return cjs;" +
  "}";

/**
 * Swaps in `VINEXT_CJS_INTEROP_HELPER` for plugin-rsc's helper. Returns
 * `undefined` when `code` does not carry the helper.
 */
export function patchRscCjsInteropHelper(code: string): string | undefined {
  if (!RSC_CJS_INTEROP_HELPER_RE.test(code)) return undefined;
  // A function replacer, so `$` in the helper is never read as a pattern.
  return code.replace(RSC_CJS_INTEROP_HELPER_RE, () => VINEXT_CJS_INTEROP_HELPER);
}

/**
 * Dev only: production builds bundle CommonJS with Rolldown, whose interop
 * already marks required ESM with `__esModule`. Runs after plugin-rsc's
 * transform, on the same environments. The helper stays on its own line and
 * keeps its name, so the source map plugin-rsc produced stays valid.
 */
export function createCjsInteropEsModulePlugin(): Plugin {
  return {
    name: "vinext:cjs-interop-esmodule",
    apply: "serve",
    enforce: "post",
    applyToEnvironment: (environment) => environment.config.dev.moduleRunnerTransform,
    transform: {
      filter: { id: /\/node_modules\//, code: "function __cjs_interop__(m) {" },
      handler(code) {
        const patched = patchRscCjsInteropHelper(code);
        if (patched === undefined) return;
        return { code: patched, map: null };
      },
    },
  };
}
