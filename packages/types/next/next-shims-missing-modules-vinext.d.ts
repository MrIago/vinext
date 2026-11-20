declare module "next/config" {
  type RuntimeConfig = {
    serverRuntimeConfig: Record<string, unknown>;
    publicRuntimeConfig: Record<string, unknown>;
  };
  export default function getConfig(): RuntimeConfig;
}

declare module "next/amp" {
  export function useAmp(): boolean;
  export function isInAmpMode(): boolean;
}

declare module "next/offline" {
  export function useOffline(): boolean;
}

// Added in Next.js canary after 16.2.7, the version the vendored types track.
// Mirrors packages/next/src/server/image-optimizer/transform.ts.
declare module "next/experimental/image-optimizer-transform" {
  export class ImageError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string);
  }
  export function getMaxAge(cacheControl: string | null | undefined): number;
  export function getSharp(): Promise<unknown>;
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
  export function imageOptimizerTransform(
    imageUpstream: ImageUpstream,
    paramsResult: ImageOptimizerTransformParams,
    opts?: ImageOptimizerTransformOptions,
  ): Promise<ImageOptimizerResult>;
}
