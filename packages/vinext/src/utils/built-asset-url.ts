import { ASSET_PREFIX_URL_DIR, resolveAssetUrlPrefix, resolveAssetsDir } from "./asset-prefix.js";
import { appendDeploymentIdQuery } from "./deployment-id.js";

const FONT_FILE_RE = /\.(?:woff2?|ttf|otf|eot)$/i;

export function renderVinextBuiltUrl(
  filename: string,
  assetPrefix: string,
  deploymentId?: string,
  hostType?: "js" | "css" | "html",
  hostId?: string,
): string {
  const urlPrefix = resolveAssetUrlPrefix(assetPrefix);
  const onDiskDir = resolveAssetsDir(assetPrefix);
  const dirPrefix = onDiskDir + "/";
  const stripped = filename.startsWith(dirPrefix)
    ? filename.slice(dirPrefix.length)
    : filename.startsWith(`${ASSET_PREFIX_URL_DIR}/`)
      ? filename.slice(ASSET_PREFIX_URL_DIR.length + 1)
      : filename;

  const url = urlPrefix + stripped;
  // Native ESM resolves a chunk's imports relative to the importing module URL.
  // Adding a deployment query to URLs embedded in JavaScript gives the entry a
  // different module identity while its relative imports remain unversioned,
  // splitting React/RSC singleton state across duplicate module graphs.
  const workerPath = `${ASSET_PREFIX_URL_DIR}/workers/`;
  const belongsToWorkerGraph = filename.includes(workerPath) || hostId?.includes(workerPath);
  if (hostType === "js" && !belongsToWorkerGraph) return url;
  // Font files are content-hashed and preloaded by the bare URL the font
  // shims render (`<link rel="preload">` and the `Link` header). An
  // `@font-face` url() must match it byte for byte, or the browser ignores
  // the preload and downloads the font a second time.
  if (hostType === "css" && FONT_FILE_RE.test(filename)) return url;
  return appendDeploymentIdQuery(url, deploymentId);
}
