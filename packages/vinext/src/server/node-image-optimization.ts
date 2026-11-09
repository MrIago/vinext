/**
 * Image optimization for files the Node.js production server serves.
 *
 * Workers optimize through the configured backend (Cloudflare Images). On
 * Node.js, Next.js transforms with `sharp`; vinext does the same when the
 * application installed it, and otherwise keeps the configured backend, if
 * any, or serves the file as-is.
 */

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "pathslash";
import { setCacheStateHeaders } from "./cache-headers.js";
import {
  handleImageOptimization,
  getImageOptimizer,
  markImageBuildAsset,
  supportedImageFormat,
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

// ---------------------------------------------------------------------------
// Disk cache of optimized images.
//
// Like Next.js' ImageOptimizerCache, each variant (source, width, quality and
// negotiated format) is kept under `<outDir>/cache/images/<key>/` until the
// larger of its max-age and `images.minimumCacheTTL` passes. A fresh entry is
// a HIT; an expired one is served STALE while the variant is optimized again
// in the background. Responses carry the variant's ETag and answer a matching
// If-None-Match with 304.
//
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/image-optimizer.ts
// ---------------------------------------------------------------------------

/** Bumped when the entry layout changes, as Next.js' CACHE_VERSION. */
const IMAGE_CACHE_VERSION = 1;
/** Headers the cache restores; the cache state and length are set per response. */
const UNCACHED_HEADERS = new Set(["x-nextjs-cache", "x-vinext-cache", "content-length", "etag"]);

type ImageCacheEntryMeta = {
  expireAt: number;
  etag: string;
  headers: [string, string][];
};

/** Next.js' getHash: SHA-256 of the parts, base64url. */
function getHash(items: ReadonlyArray<string | number | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const item of items) hash.update(typeof item === "number" ? String(item) : item);
  return hash.digest("base64url");
}

/** The `s-maxage` or `max-age` of a Cache-Control value, like Next.js' getMaxAge. */
function maxAgeOf(cacheControl: string | null): number {
  const match = cacheControl?.match(/(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*"?(\d+)"?/i);
  return match ? Number(match[1]) : 0;
}

/** Whether an If-None-Match header names `etag` (or is `*`). */
function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((token) => {
    const value = token.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    return value === "*" || value === etag;
  });
}

function notModifiedResponse(etag: string, headers: Headers): Response {
  const out = new Headers({ ETag: etag });
  for (const name of ["cache-control", "vary", "content-security-policy"]) {
    const value = headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return new Response(null, { status: 304, headers: out });
}

export class NodeImageCache {
  private readonly revalidating = new Map<string, Promise<void>>();

  private readonly enabled: boolean;
  /** Entry sizes in least-recently-used order, loaded on the first write. */
  private lru: Promise<Map<string, number>> | null = null;

  /**
   * @param cacheDir Where variants are kept, `<outDir>/cache/images`.
   * @param maximumSize `images.maximumDiskCacheSize`: 0 disables the cache,
   *   a positive size evicts the least recently used variants past it, and
   *   undefined keeps every variant.
   */
  constructor(
    private readonly cacheDir: string,
    private readonly maximumSize?: number,
  ) {
    this.enabled = maximumSize !== 0;
  }

  /** Like Next.js' disk LRU, start from the entries on disk, oldest expiry first. */
  private loadLru(): Promise<Map<string, number>> {
    this.lru ??= (async () => {
      const entries: Array<{ key: string; size: number; expireAt: number }> = [];
      for (const key of await fsp.readdir(this.cacheDir).catch(() => [])) {
        const entry = await this.read(key);
        if (entry)
          entries.push({ key, size: entry.body.byteLength, expireAt: entry.meta.expireAt });
      }
      entries.sort((a, b) => a.expireAt - b.expireAt);
      return new Map(entries.map((entry) => [entry.key, entry.size]));
    })();
    return this.lru;
  }

  private async touch(key: string): Promise<void> {
    if (!this.maximumSize || !this.lru) return;
    const lru = await this.lru;
    const size = lru.get(key);
    if (size === undefined) return;
    lru.delete(key);
    lru.set(key, size);
  }

  private async track(key: string, size: number): Promise<void> {
    if (!this.maximumSize) return;
    const lru = await this.loadLru();
    lru.delete(key);
    lru.set(key, size);
    let total = 0;
    for (const entrySize of lru.values()) total += entrySize;
    for (const [oldest, oldestSize] of lru) {
      if (total <= this.maximumSize) break;
      lru.delete(oldest);
      total -= oldestSize;
      await fsp.rm(path.join(this.cacheDir, oldest), { recursive: true, force: true });
    }
  }

  /** Next.js' getCacheKey: version, source, width, quality and Accept-selected format. */
  static key(request: Request, imageConfig: ImageConfig | undefined): string | null {
    const url = new URL(request.url);
    const source = url.searchParams.get("url");
    const width = url.searchParams.get("w");
    const quality = url.searchParams.get("q");
    if (!source || !width || !quality) return null;
    const mimeType = supportedImageFormat(request.headers.get("Accept"), imageConfig?.formats);
    return getHash([IMAGE_CACHE_VERSION, source, width, quality, mimeType]);
  }

  private async read(key: string): Promise<{ meta: ImageCacheEntryMeta; body: Uint8Array } | null> {
    try {
      const dir = path.join(this.cacheDir, key);
      const meta = JSON.parse(await fsp.readFile(path.join(dir, "entry.json"), "utf8"));
      const body = new Uint8Array(await fsp.readFile(path.join(dir, "body")));
      if (body.byteLength === 0 || typeof meta?.expireAt !== "number") return null;
      return { meta, body };
    } catch {
      return null;
    }
  }

  /** The entry for an optimized response, with its expiry and ETag. */
  private async toEntry(
    response: Response,
    imageConfig: ImageConfig | undefined,
  ): Promise<{ meta: ImageCacheEntryMeta; body: Uint8Array }> {
    const body = new Uint8Array(await response.arrayBuffer());
    const maxAge = Math.max(
      maxAgeOf(response.headers.get("Cache-Control")),
      imageConfig?.minimumCacheTTL ?? 14400,
    );
    return {
      meta: {
        expireAt: Date.now() + maxAge * 1000,
        etag: getHash([body]),
        headers: [...response.headers].filter(([name]) => !UNCACHED_HEADERS.has(name)),
      },
      body,
    };
  }

  private async write(
    key: string,
    response: Response,
    imageConfig: ImageConfig | undefined,
  ): Promise<{ meta: ImageCacheEntryMeta; body: Uint8Array }> {
    const entry = await this.toEntry(response, imageConfig);
    if (entry.body.byteLength === 0) return entry;
    const dir = path.join(this.cacheDir, key);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "body"), entry.body);
      await fsp.writeFile(path.join(dir, "entry.json"), JSON.stringify(entry.meta));
      await this.track(key, entry.body.byteLength);
    } catch (error) {
      console.error(`[vinext] Failed to write image to cache ${key}`, error);
    }
    return entry;
  }

  private respond(
    request: Request,
    entry: { meta: ImageCacheEntryMeta; body: Uint8Array },
    state: "HIT" | "STALE" | "MISS",
  ): Response {
    const headers = new Headers(entry.meta.headers);
    if (matchesEtag(request.headers.get("If-None-Match"), entry.meta.etag)) {
      return notModifiedResponse(entry.meta.etag, headers);
    }
    headers.set("ETag", entry.meta.etag);
    headers.set("Content-Length", String(entry.body.byteLength));
    setCacheStateHeaders(headers, state);
    return new Response(request.method === "HEAD" ? null : new Uint8Array(entry.body), {
      status: 200,
      headers,
    });
  }

  /**
   * Answer an image request from the cache, or through `optimize` (whose
   * successful response is cached) when it holds no entry.
   */
  async handle(
    request: Request,
    imageConfig: ImageConfig | undefined,
    optimize: () => Promise<Response>,
  ): Promise<Response> {
    const key = this.enabled ? NodeImageCache.key(request, imageConfig) : null;
    const cached = key === null ? null : await this.read(key);
    if (key !== null && cached !== null) {
      await this.touch(key);
      if (Date.now() <= cached.meta.expireAt) return this.respond(request, cached, "HIT");
      if (!this.revalidating.has(key)) {
        const revalidation = optimize()
          .then(async (response) => {
            if (response.status === 200) await this.write(key, response, imageConfig);
            else await response.body?.cancel();
          })
          .catch((error: unknown) => {
            console.error("[vinext] Failed to revalidate cached image", error);
          })
          .finally(() => this.revalidating.delete(key));
        this.revalidating.set(key, revalidation);
      }
      return this.respond(request, cached, "STALE");
    }
    const response = await optimize();
    if (response.status !== 200 || !response.body) return response;
    const entry =
      key === null
        ? await this.toEntry(response, imageConfig)
        : await this.write(key, response, imageConfig);
    return this.respond(request, entry, "MISS");
  }
}
