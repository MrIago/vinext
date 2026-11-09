import type { Plugin, ResolvedConfig } from "vite";

type AssetDeps = { js: unknown[]; css: unknown[] };
type RscAssetsManifest = {
  clientEntryDeps?: AssetDeps;
  clientReferenceDeps?: Record<string, AssetDeps>;
};
type RscManager = { buildAssetsManifest?: RscAssetsManifest };

/**
 * The URL a manifest entry points at: a string, or a runtime asset whose
 * expression still names the file.
 */
function assetUrlText(url: unknown): string | null {
  if (typeof url === "string") return url;
  if (url && typeof url === "object" && "runtime" in url) {
    const runtime = (url as { runtime: unknown }).runtime;
    return typeof runtime === "string" ? runtime : null;
  }
  return null;
}

/**
 * Keep only the JS deps whose file the client build emitted.
 */
export function dropUnemittedJsDeps(
  manifest: RscAssetsManifest,
  emittedJsFiles: ReadonlySet<string>,
): number {
  let dropped = 0;
  const emitted = [...emittedJsFiles];
  const filter = (deps: AssetDeps | undefined) => {
    if (!deps) return;
    const before = deps.js.length;
    deps.js = deps.js.filter((url) => {
      const text = assetUrlText(url);
      // Leave a URL we can't read alone rather than drop a real chunk.
      return text === null || emitted.some((fileName) => text.endsWith(fileName));
    });
    dropped += before - deps.js.length;
  };
  filter(manifest.clientEntryDeps);
  for (const deps of Object.values(manifest.clientReferenceDeps ?? {})) filter(deps);
  return dropped;
}

/**
 * `@vitejs/plugin-rsc` collects each client reference's JS deps from the
 * client bundle in `generateBundle`, before Vite removes the chunks that hold
 * only CSS (a plugin that groups CSS into its own chunk with
 * `codeSplitting.groups` makes them). The assets manifest then lists a `.js`
 * URL that was never written, and every page load preloads a 404 (#3064).
 * Once the client bundle is final, drop those URLs from the manifest before
 * plugin-rsc writes it.
 */
export function createPureCssChunkPreloadsPlugin(options: {
  getManager(config: ResolvedConfig): Promise<RscManager | undefined>;
}): Plugin {
  let config: ResolvedConfig;
  return {
    name: "vinext:pure-css-chunk-preloads",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
    },
    async writeBundle(_options, bundle) {
      if (this.environment?.name !== "client") return;
      const manifest = (await options.getManager(config))?.buildAssetsManifest;
      if (!manifest) return;
      const emittedJsFiles = new Set(
        Object.values(bundle)
          .filter((output) => output.type === "chunk")
          .map((chunk) => chunk.fileName),
      );
      dropUnemittedJsDeps(manifest, emittedJsFiles);
    },
  };
}
