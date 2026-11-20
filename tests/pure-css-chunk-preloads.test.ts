import { describe, expect, it } from "vitest";
import { dropUnemittedJsDeps } from "../packages/vinext/src/plugins/pure-css-chunk-preloads.js";

// https://github.com/cloudflare/vinext/issues/3064: a chunk that holds only
// CSS is never written as JS, so the assets manifest must not preload it.
describe("dropUnemittedJsDeps", () => {
  it("drops JS URLs the client build never emitted", () => {
    const manifest = {
      clientEntryDeps: {
        js: ["/_next/static/chunks/index-a.js", "/_next/static/chunks/devup-ui.css-x.js"],
        css: ["/_next/static/chunks/devup-ui-x.css"],
      },
      clientReferenceDeps: {
        ref: {
          js: ["/_next/static/chunks/button-b.js", "/_next/static/chunks/devup-ui.css-y.js"],
          css: [],
        },
      },
    };
    const dropped = dropUnemittedJsDeps(
      manifest,
      new Set(["_next/static/chunks/index-a.js", "_next/static/chunks/button-b.js"]),
    );
    expect(dropped).toBe(2);
    expect(manifest.clientEntryDeps.js).toEqual(["/_next/static/chunks/index-a.js"]);
    expect(manifest.clientEntryDeps.css).toEqual(["/_next/static/chunks/devup-ui-x.css"]);
    expect(manifest.clientReferenceDeps.ref.js).toEqual(["/_next/static/chunks/button-b.js"]);
  });

  it("matches whole file names only", () => {
    const manifest = { clientEntryDeps: { js: ["/_next/static/chunks/other-a.js"], css: [] } };
    dropUnemittedJsDeps(manifest, new Set(["a.js"]));
    expect(manifest.clientEntryDeps.js).toEqual([]);
  });

  it("leaves URLs it can't read alone", () => {
    const runtimeAsset = { other: true };
    const manifest = { clientEntryDeps: { js: [runtimeAsset], css: [] } };
    dropUnemittedJsDeps(manifest, new Set());
    expect(manifest.clientEntryDeps.js).toEqual([runtimeAsset]);
  });
});
