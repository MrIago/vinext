/**
 * next/experimental/image-optimizer-transform shim
 *
 * Next.js exposes its image optimizer's transform step as a stable module for
 * adapters that run image optimization out of process (#3830). This is the
 * same contract on vinext's own optimizer pieces: the sniffed source type,
 * animated and bypassed types passed through, the app's `sharp`, and a
 * fallback to the source when optimizing fails.
 *
 * Ported from Next.js: packages/next/src/server/image-optimizer/transform.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/image-optimizer/transform.ts
 */
import { createHash } from "node:crypto";
import { isAnimatedImage } from "../server/image-animation.js";
import { cacheControlMaxAge, detectImageContentType } from "../server/image-optimization.js";
import { loadSharp, optimizeImageWithSharp, type Sharp } from "../server/image-sharp.js";
import { ImageSourceReader } from "../server/image-source-reader.js";

export class ImageError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function getMaxAge(cacheControl: string | null | undefined): number {
  return cacheControlMaxAge(cacheControl ?? null);
}

export function getSharp(): Promise<Sharp | null> {
  return loadSharp([process.cwd()]);
}

export type ImageUpstream = {
  buffer: Buffer;
  contentType: string | null | undefined;
  cacheControl: string | null | undefined;
  etag: string;
};

export type ImageOptimizerTransformParams = {
  href: string;
  width: number;
  quality: number;
  mimeType: string;
};

export type ImageOptimizerTransformLogger = {
  error(...args: unknown[]): void;
  warnOnce(message: string): void;
};

export type ImageOptimizerTransformOptions = {
  dangerouslyAllowSVG?: boolean;
  minimumCacheTTL?: number;
  concurrency?: number | null;
  operationCache?: boolean | null;
  maxInputPixels?: number;
  sequentialRead?: boolean | null;
  timeoutInSeconds?: number;
  mozjpeg?: boolean;
  logger?: ImageOptimizerTransformLogger;
};

export type ImageOptimizerResult = {
  buffer: Buffer;
  contentType: string;
  maxAge: number;
  etag: string;
  upstreamEtag: string;
  optimized: boolean;
  error?: unknown;
};

const ANIMATABLE_TYPES = ["image/webp", "image/png", "image/gif"];
const BYPASS_TYPES = [
  "image/svg+xml",
  "image/x-icon",
  "image/x-icns",
  "image/bmp",
  "image/jxl",
  "image/heic",
];

function getImageEtag(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("base64url");
}

export async function imageOptimizerTransform(
  imageUpstream: ImageUpstream,
  paramsResult: ImageOptimizerTransformParams,
  opts: ImageOptimizerTransformOptions = {},
): Promise<ImageOptimizerResult> {
  const { href, quality, width, mimeType } = paramsResult;
  const { buffer: upstreamBuffer, etag: upstreamEtag } = imageUpstream;
  const { dangerouslyAllowSVG = false, minimumCacheTTL = 0 } = opts;
  const maxAge = Math.max(minimumCacheTTL, getMaxAge(imageUpstream.cacheControl));
  const upstreamType = detectImageContentType(new Uint8Array(upstreamBuffer), null);

  if (!upstreamType || !upstreamType.startsWith("image/") || upstreamType.includes(",")) {
    opts.logger?.error(
      "The requested resource isn't a valid image for",
      href,
      "received",
      upstreamType,
    );
    throw new ImageError(400, "The requested resource isn't a valid image.");
  }
  if (upstreamType.startsWith("image/svg") && !dangerouslyAllowSVG) {
    opts.logger?.error(
      `The requested resource "${href}" has type "${upstreamType}" but dangerouslyAllowSVG is disabled. Consider adding the "unoptimized" property to the <Image>.`,
    );
    throw new ImageError(400, '"url" parameter is valid but image type is not allowed');
  }
  const passThrough = (): ImageOptimizerResult => ({
    buffer: upstreamBuffer,
    contentType: upstreamType,
    maxAge,
    etag: upstreamEtag,
    upstreamEtag,
    optimized: false,
  });
  if (
    ANIMATABLE_TYPES.includes(upstreamType) &&
    (await isAnimatedImage(
      new ImageSourceReader(
        new Response(new Uint8Array(upstreamBuffer)).body!,
        upstreamBuffer.byteLength,
      ),
    ))
  ) {
    opts.logger?.warnOnce(
      `The requested resource "${href}" is an animated image so it will not be optimized. Consider adding the "unoptimized" property to the <Image>.`,
    );
    return passThrough();
  }
  if (BYPASS_TYPES.includes(upstreamType)) return passThrough();

  const contentType = mimeType
    ? mimeType
    : upstreamType === "image/webp" || upstreamType === "image/avif"
      ? "image/jpeg"
      : upstreamType;

  try {
    const sharp = await getSharp();
    if (!sharp) throw new Error("sharp is not installed");
    const { data } = await optimizeImageWithSharp(sharp, {
      buffer: new Uint8Array(upstreamBuffer),
      contentType,
      quality,
      width,
    });
    const buffer = Buffer.from(data);
    return {
      buffer,
      contentType,
      maxAge,
      etag: getImageEtag(buffer),
      upstreamEtag,
      optimized: true,
    };
  } catch (error) {
    // If we fail to optimize, fall back to the original image.
    return {
      buffer: upstreamBuffer,
      contentType: upstreamType,
      maxAge: minimumCacheTTL,
      etag: upstreamEtag,
      upstreamEtag,
      optimized: false,
      error,
    };
  }
}
