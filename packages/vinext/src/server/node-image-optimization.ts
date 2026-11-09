/**
 * Image optimization for files the Node.js production server serves.
 *
 * Workers optimize through the configured backend (Cloudflare Images). On
 * Node.js, Next.js transforms with `sharp`; vinext does the same when the
 * application installed it, and otherwise keeps the configured backend, if
 * any, or serves the file as-is.
 */

import fsp from "node:fs/promises";
import {
  handleImageOptimization,
  getImageOptimizer,
  markImageBuildAsset,
  type ImageConfig,
  type ImageOptimizer,
} from "./image-optimization.js";
import { loadSharpImageOptimizer } from "./image-sharp.js";

/**
 * The optimizer a Node.js server uses: one the application registered, else
 * `sharp` resolved from `roots`, else none.
 */
export async function resolveNodeImageOptimizer(
  roots: readonly string[],
): Promise<ImageOptimizer | null> {
  return getImageOptimizer() ?? (await loadSharpImageOptimizer(roots));
}

export type NodeImageSource = {
  /** The file's bytes when held in memory, else read from `path`. */
  buffer?: Uint8Array;
  path: string;
  /** The type the file's bytes were detected as. */
  contentType: string;
  /** Whether the file is a hashed `_next/static` build asset. */
  isBuildAsset: boolean;
  /** The Cache-Control a direct request for a public file receives. */
  cacheControl: string | null;
};

/**
 * Answer an image request for a file through `optimizer`, with the headers,
 * cache policy and fallbacks of {@link handleImageOptimization}.
 */
export function optimizeNodeImage(
  request: Request,
  source: NodeImageSource,
  optimizer: ImageOptimizer,
  allowedWidths: number[] | undefined,
  imageConfig: ImageConfig | undefined,
): Promise<Response> {
  return handleImageOptimization(
    request,
    {
      fetchAsset: async () => {
        const bytes = source.buffer ?? new Uint8Array(await fsp.readFile(source.path));
        const headers = new Headers({ "Content-Type": source.contentType });
        if (!source.isBuildAsset && source.cacheControl) {
          headers.set("Cache-Control", source.cacheControl);
        }
        const response = new Response(new Uint8Array(bytes), { headers });
        return source.isBuildAsset ? markImageBuildAsset(response) : response;
      },
      transformImage: (body, options) => optimizer.transformImage(body, options),
    },
    allowedWidths,
    imageConfig,
  );
}
