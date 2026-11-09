/**
 * The Node.js image optimizer backed by `sharp`, the library Next.js uses.
 *
 * vinext never depends on `sharp`: it is resolved from the application, the
 * way `next` lists it as an optional dependency. When the application has it
 * installed, the Node.js server and the build optimize images with it; when it
 * does not, images are served as-is, as before.
 *
 * Mirrors Next.js' packages/next/src/server/image-optimizer/sharp.ts.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/image-optimizer/sharp.ts
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "pathslash";
import type { ImageOptimizer } from "./image-optimization.js";

/** The part of a sharp pipeline vinext uses. */
type SharpPipeline = {
  timeout(options: { seconds: number }): SharpPipeline;
  rotate(): SharpPipeline;
  resize(width: number, height?: number, options?: { withoutEnlargement?: boolean }): SharpPipeline;
  avif(options: { quality: number; effort: number }): SharpPipeline;
  webp(options: { quality: number }): SharpPipeline;
  png(options: { quality: number }): SharpPipeline;
  jpeg(options: { quality: number; mozjpeg: boolean }): SharpPipeline;
  toBuffer(options: {
    resolveWithObject: true;
  }): Promise<{ data: Buffer; info: { format: string } }>;
};

/** The part of the `sharp` module vinext uses. */
export type Sharp = {
  (input: Uint8Array, options?: { sequentialRead?: boolean }): SharpPipeline;
  concurrency(threads?: number): number;
  block?(options: { operation: string[] }): void;
  unblock?(options: { operation: string[] }): void;
};

const loaded = new Map<string, Promise<Sharp | null>>();

/**
 * Load the application's `sharp`, resolved from the first of `roots` that has
 * it, or null when none does. Like Next.js' getSharp, only the decoders of the
 * formats the optimizer accepts stay enabled, and the libvips thread pool is
 * halved (quartered in development) to bound memory.
 */
export function loadSharp(roots: readonly string[]): Promise<Sharp | null> {
  const key = roots.join("\0");
  let pending = loaded.get(key);
  if (!pending) {
    pending = Promise.resolve().then(() => {
      for (const root of roots) {
        const packageDir = findInstalledPackage(root, "sharp");
        if (!packageDir) continue;
        try {
          const sharp = createRequire(path.join(root, "noop.js"))(packageDir) as Sharp;
          configureSharp(sharp);
          return sharp;
        } catch (error) {
          console.warn(`[vinext] Failed to load sharp from ${packageDir}:`, error);
        }
      }
      return null;
    });
    loaded.set(key, pending);
  }
  return pending;
}

/**
 * The directory of `name` in the nearest `node_modules` at or above `root`.
 * Unlike `require.resolve`, NODE_PATH and global folders are not searched:
 * only a package the application installed counts.
 */
function findInstalledPackage(root: string, name: string): string | null {
  let dir = path.resolve(root);
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const configured = new WeakSet<Sharp>();

function configureSharp(sharp: Sharp): void {
  if (configured.has(sharp)) return;
  configured.add(sharp);
  sharp.block?.({ operation: ["VipsForeignLoad"] });
  sharp.unblock?.({
    operation: [
      "VipsForeignLoadHeif", // avif
      "VipsForeignLoadJpeg",
      "VipsForeignLoadNsgif",
      "VipsForeignLoadPng",
      "VipsForeignLoadSvg",
      "VipsForeignLoadTiff",
      "VipsForeignLoadWebp",
    ],
  });
  const threads = sharp.concurrency();
  if (threads > 1) {
    const divisor = process.env.NODE_ENV === "development" ? 4 : 2;
    sharp.concurrency(Math.floor(Math.max(threads / divisor, 1)));
  }
}

const SHARP_FORMAT_MEDIA_TYPES: Record<string, string> = {
  avif: "image/avif",
  heif: "image/avif",
  webp: "image/webp",
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  tiff: "image/tiff",
};

/**
 * Resize and encode `buffer` like Next.js' optimizeImage: honour the EXIF
 * orientation, never enlarge, and encode to `contentType` (AVIF quality scaled
 * to match WebP). A type sharp is not asked to encode keeps the source's.
 */
export async function optimizeImageWithSharp(
  sharp: Sharp,
  {
    buffer,
    contentType,
    quality,
    width,
    height,
  }: { buffer: Uint8Array; contentType: string; quality: number; width: number; height?: number },
): Promise<{ data: Buffer; contentType: string }> {
  const transformer = sharp(buffer, { sequentialRead: true }).timeout({ seconds: 7 }).rotate();
  if (height) {
    transformer.resize(width, height);
  } else {
    transformer.resize(width, undefined, { withoutEnlargement: true });
  }
  if (contentType === "image/avif") {
    transformer.avif({ quality: Math.max(Math.round(quality * (50 / 80)), 1), effort: 3 });
  } else if (contentType === "image/webp") {
    transformer.webp({ quality });
  } else if (contentType === "image/png") {
    transformer.png({ quality });
  } else if (contentType === "image/jpeg") {
    transformer.jpeg({ quality, mozjpeg: true });
  }
  const { data, info } = await transformer.toBuffer({ resolveWithObject: true });
  return { data, contentType: SHARP_FORMAT_MEDIA_TYPES[info.format] ?? contentType };
}

/** An {@link ImageOptimizer} that transforms with the given `sharp`. */
export function createSharpImageOptimizer(sharp: Sharp): ImageOptimizer {
  return {
    async transformImage(body, { width, format, quality }) {
      const buffer = new Uint8Array(await new Response(body).arrayBuffer());
      const optimized = await optimizeImageWithSharp(sharp, {
        buffer,
        contentType: format,
        quality,
        width,
      });
      return new Response(new Uint8Array(optimized.data), {
        headers: { "Content-Type": optimized.contentType },
      });
    },
  };
}

let warnedMissingSharp = false;

/**
 * The sharp optimizer for an application, or null with a one-time hint when
 * the application has not installed `sharp`.
 */
export async function loadSharpImageOptimizer(
  roots: readonly string[],
): Promise<ImageOptimizer | null> {
  const sharp = await loadSharp(roots);
  if (sharp) return createSharpImageOptimizer(sharp);
  if (!warnedMissingSharp) {
    warnedMissingSharp = true;
    console.warn(
      "[vinext] Images are served without optimization because `sharp` is not installed. " +
        "Install it in your app to resize and convert them as Next.js does: npm install sharp",
    );
  }
  return null;
}
