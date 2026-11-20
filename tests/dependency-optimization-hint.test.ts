import { describe, expect, it } from "vitest";
import { describeDependencyOptimizationFailure } from "../packages/vinext/src/server/socket-error-backstop.js";

// https://github.com/cloudflare/vinext/issues/1220: a Node-only CommonJS
// package fails the dependency optimizer with a raw Rolldown error.
describe("describeDependencyOptimizationFailure", () => {
  it("names the package the optimizer could not pre-bundle", () => {
    const err = new Error(
      "Error during dependency optimization:\n\nBuild failed with 1 error:\n\n" +
        "[UNRESOLVED_IMPORT] Could not resolve '../..' in node_modules/superagent/lib/node/agent.js",
    );
    const hint = describeDependencyOptimizationFailure(err);
    expect(hint).toContain('"superagent"');
    expect(hint).toContain("serverExternalPackages");
    expect(hint).toContain("optimizeDeps.exclude");
  });

  it("keeps scoped package names whole", () => {
    const hint = describeDependencyOptimizationFailure(
      "Error during dependency optimization:\n[MISSING_EXPORT] x in node_modules/@scope/pkg/index.js",
    );
    expect(hint).toContain('"@scope/pkg"');
  });

  it("blames the failing file's package, not the import chain", () => {
    const hint = describeDependencyOptimizationFailure(
      "Error during dependency optimization:\n" +
        "[UNRESOLVED_IMPORT] Could not resolve '../..' in node_modules/superagent/lib/node/agent.js\n" +
        "  Help: imported by node_modules/wpapi/lib/http-transport.js",
    );
    expect(hint).toContain('"superagent"');
    expect(hint).not.toContain('"wpapi"');
  });

  it("ignores other errors", () => {
    expect(describeDependencyOptimizationFailure(new Error("boom"))).toBeNull();
    expect(
      describeDependencyOptimizationFailure(new Error("Error during dependency optimization")),
    ).toBeNull();
  });
});
