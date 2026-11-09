/**
 * Server-safe next/image helpers.
 *
 * Holds the image config, URL builders, and `getImageProps`. This module has
 * no "use client" directive so `getImageProps` can run in Server Components,
 * matching Next.js where `next/image` (shared/lib/image-external.tsx) is
 * server-safe and only the Image component is a client reference.
 *
 * Remote images are validated against `images.remotePatterns` and
 * `images.domains` from next.config.js. Unmatched URLs are blocked
 * in production and warn in development, matching Next.js behavior.
 */
import type React from "react";
import type {
  ImageLoader,
  ImageProps,
  ImgProps,
  StaticImport,
} from "@vinext/types/next/upstream/dist/shared/lib/get-img-props";
// The vinext plugin aliases this specifier to the user's `images.loaderFile`.
// A namespace import, so a file without a default export reaches the
// diagnostic in withConfiguredLoader instead of failing module linking.
import * as imageLoaderFileModule from "vinext/shims/image-loader-file";
import { getDeploymentId } from "../utils/deployment-id.js";
import { hasRemoteMatch, isPrivateIp, type RemotePattern } from "./image-config.js";

/**
 * Image config injected at build time via Vite define.
 * Serialized as JSON — parsed once at module level.
 */
const __imageRemotePatterns: RemotePattern[] = (() => {
  try {
    return JSON.parse(process.env.__VINEXT_IMAGE_REMOTE_PATTERNS ?? "[]");
  } catch {
    return [];
  }
})();
const __imageDomains: string[] = (() => {
  try {
    return JSON.parse(process.env.__VINEXT_IMAGE_DOMAINS ?? "[]");
  } catch {
    return [];
  }
})();
const __hasImageConfig = __imageRemotePatterns.length > 0 || __imageDomains.length > 0;
export const __isDev = process.env.NODE_ENV !== "production";
const __imageDeviceSizes: number[] = (() => {
  try {
    return JSON.parse(
      process.env.__VINEXT_IMAGE_DEVICE_SIZES ?? "[640,750,828,1080,1200,1920,2048,3840]",
    );
  } catch {
    return [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
  }
})();
const __imageSizes: number[] = (() => {
  try {
    return JSON.parse(process.env.__VINEXT_IMAGE_SIZES ?? "[32,48,64,96,128,256,384]");
  } catch {
    return [32, 48, 64, 96, 128, 256, 384];
  }
})();
// `images.qualities`, or null when unset. Sorted ascending like Next.js's
// image config, so a tie in findClosestQuality resolves to the lower quality.
const __imageQualities: number[] | null = (() => {
  try {
    const qualities: number[] | null = JSON.parse(process.env.__VINEXT_IMAGE_QUALITIES ?? "null");
    return Array.isArray(qualities) ? qualities.sort((a, b) => a - b) : null;
  } catch {
    return null;
  }
})();
/**
 * Whether dangerouslyAllowSVG is enabled in next.config.js.
 * When false (default), .svg sources auto-skip the optimization endpoint
 * and are served directly, matching Next.js behavior.
 * When true, .svg sources are routed through the optimizer (served as-is
 * with security headers).
 */
export const __dangerouslyAllowSVG = process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_SVG === "true";
/**
 * Whether dangerouslyAllowLocalIP is enabled in next.config.js.
 * When false (default), remote image URLs with literal private-IP hostnames
 * are blocked to mitigate SSRF risk.
 */
const __dangerouslyAllowLocalIP = process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_LOCAL_IP === "true";
export const __globallyUnoptimized = process.env.__VINEXT_IMAGE_UNOPTIMIZED === "true";
/** `images.loader: "custom"`: optimized images need a loader prop. */
export const __customImageLoader = process.env.__VINEXT_IMAGE_CUSTOM_LOADER === "true";

/**
 * Validate that a remote URL is allowed by the configured remote patterns.
 * Returns true if the URL is allowed, false otherwise.
 *
 * When no remotePatterns/domains are configured, all remote URLs are allowed
 * (backwards-compatible — user hasn't opted into restriction).
 *
 * When patterns ARE configured, only matching URLs are allowed.
 * In development, non-matching URLs produce a console warning.
 * In production, non-matching URLs are blocked (src replaced with empty string).
 *
 * Private-IP hostnames are additionally rejected unless dangerouslyAllowLocalIP
 * is set, mirroring Next.js's fetchExternalImage guard.
 */
export function validateRemoteUrl(src: string): { allowed: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(src, "http://n");
  } catch {
    return { allowed: false, reason: `Invalid URL: ${src}` };
  }

  if (!__dangerouslyAllowLocalIP && isPrivateIp(url.hostname)) {
    // Best-effort guard for literal-IP hostnames only. Domain names resolving
    // to private IPs cannot be caught without server-side DNS resolution.
    // See: Next.js fetchExternalImage in packages/next/src/server/image-optimizer.ts
    return {
      allowed: false,
      reason: `Image URL "${src}" resolved to private IP. If this is expected and you understand SSRF risk, use images.dangerouslyAllowLocalIP = true to continue.`,
    };
  }

  if (!__hasImageConfig) {
    // No image config — allow everything (backwards-compatible)
    return { allowed: true };
  }

  if (hasRemoteMatch(__imageDomains, __imageRemotePatterns, url)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Image URL "${src}" is not configured in images.remotePatterns or images.domains in next.config.js. See: https://nextjs.org/docs/messages/next-image-unconfigured-host`,
  };
}

/**
 * Sanitize a blurDataURL to prevent CSS injection.
 *
 * A crafted data URL containing `)` can break out of the `url()` CSS function,
 * allowing injection of arbitrary CSS properties or rules. Characters like `{`,
 * `}`, and `\` can also assist in crafting injection payloads.
 *
 * This validates the URL starts with `data:image/` and rejects characters that
 * could escape the `url()` context. Semicolons are allowed since they're part
 * of valid data URLs (`data:image/png;base64,...`) and harmless inside `url()`.
 *
 * Returns undefined for invalid URLs, which causes the blur placeholder to be
 * skipped gracefully.
 */
export function sanitizeBlurDataURL(url: string): string | undefined {
  // Must be a data: image URL
  if (!url.startsWith("data:image/")) return undefined;
  return sanitizeCssUrl(url);
}

/** A URL safe inside CSS `url("...")`, or undefined. */
function sanitizeCssUrl(url: string): string | undefined {
  // Reject characters that can break out of CSS url():
  //   ) - closes url()
  //   ( - could open nested functions
  //   { } - CSS rule boundaries
  //   \ - CSS escape sequences
  //   newlines - break CSS parsing
  if (/[)(}{\\'"\n\r]/.test(url)) return undefined;
  return url;
}

/** Whether the server optimizes remote sources (the Node.js server; not Workers). */
const __remoteImagesOptimized = process.env.__VINEXT_IMAGE_REMOTE_OPTIMIZATION === "true";

/**
 * Whether `/_next/image` optimizes this remote src: the build serves from the
 * Node.js server, which fetches remote sources safely, and images.remotePatterns
 * (or images.domains) allows it. Next.js' default loader sends such a src
 * through the endpoint; elsewhere vinext keeps rendering it as-is.
 */
export function isServerOptimizedRemoteUrl(src: string): boolean {
  if (!__remoteImagesOptimized || !/^https?:\/\//i.test(src)) return false;
  try {
    const url = new URL(src);
    return (
      hasRemoteMatch(__imageDomains, __imageRemotePatterns, url) &&
      (__dangerouslyAllowLocalIP || !isPrivateIp(url.hostname))
    );
  } catch {
    return false;
  }
}

/**
 * Determine if a src is a remote URL (CDN-optimizable) or local.
 */
export function isRemoteUrl(src: string): boolean {
  return src.startsWith("http://") || src.startsWith("https://") || src.startsWith("//");
}

export function isSvgUrl(src: string): boolean {
  try {
    return new URL(src, "http://vinext.local").pathname.toLowerCase().endsWith(".svg");
  } catch {
    return false;
  }
}

export function getFillStyle(
  style?: React.CSSProperties,
  backgroundStyle?: React.CSSProperties,
): React.CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    ...backgroundStyle,
    ...style,
  };
}

/**
 * Resolve src, width, height, blurDataURL from Image props (string or StaticImageData).
 * Shared by the Image component and getImageProps to keep behavior in sync.
 */
export function resolveImageSource(v: {
  src: string | StaticImport;
  width?: number | `${number}`;
  height?: number | `${number}`;
  blurDataURL?: string;
}): {
  src: string;
  width?: number;
  height?: number;
  blurDataURL?: string;
  blurWidth?: number;
  blurHeight?: number;
} {
  const staticData = typeof v.src === "object" && "default" in v.src ? v.src.default : v.src;
  const src = typeof staticData === "string" ? staticData : staticData.src;
  const sourceWidth = v.width ?? (typeof staticData === "object" ? staticData.width : undefined);
  const sourceHeight = v.height ?? (typeof staticData === "object" ? staticData.height : undefined);
  const imgWidth = typeof sourceWidth === "string" ? Number(sourceWidth) : sourceWidth;
  const imgHeight = typeof sourceHeight === "string" ? Number(sourceHeight) : sourceHeight;
  const imgBlurDataURL =
    v.blurDataURL ?? (typeof staticData === "object" ? staticData.blurDataURL : undefined);
  return {
    src,
    width: imgWidth,
    height: imgHeight,
    blurDataURL: imgBlurDataURL,
    blurWidth: typeof staticData === "object" ? staticData.blurWidth : undefined,
    blurHeight: typeof staticData === "object" ? staticData.blurHeight : undefined,
  };
}

/**
 * Next.js' blur placeholder: the blur image scaled up behind an SVG Gaussian
 * blur, sized from the static import's blur size or the image's own size.
 *
 * Ported from Next.js: packages/next/src/shared/lib/image-blur-svg.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/image-blur-svg.ts
 */
function getImageBlurSvg({
  widthInt,
  heightInt,
  blurWidth,
  blurHeight,
  blurDataURL,
  objectFit,
}: {
  widthInt?: number;
  heightInt?: number;
  blurWidth?: number;
  blurHeight?: number;
  blurDataURL: string;
  objectFit?: string;
}): string {
  const std = 20;
  const svgWidth = blurWidth ? blurWidth * 40 : widthInt;
  const svgHeight = blurHeight ? blurHeight * 40 : heightInt;
  const viewBox = svgWidth && svgHeight ? `viewBox='0 0 ${svgWidth} ${svgHeight}'` : "";
  const preserveAspectRatio = viewBox
    ? "none"
    : objectFit === "contain"
      ? "xMidYMid"
      : objectFit === "cover"
        ? "xMidYMid slice"
        : "none";
  return `%3Csvg xmlns='http://www.w3.org/2000/svg' ${viewBox}%3E%3Cfilter id='b' color-interpolation-filters='sRGB'%3E%3CfeGaussianBlur stdDeviation='${std}'/%3E%3CfeColorMatrix values='1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1' result='s'/%3E%3CfeFlood x='0' y='0' width='100%25' height='100%25'/%3E%3CfeComposite operator='out' in='s'/%3E%3CfeComposite in2='SourceGraphic'/%3E%3CfeGaussianBlur stdDeviation='${std}'/%3E%3C/filter%3E%3Cimage width='100%25' height='100%25' x='0' y='0' preserveAspectRatio='${preserveAspectRatio}' style='filter: url(%23b);' href='${blurDataURL}'/%3E%3C/svg%3E`;
}

const INVALID_BACKGROUND_SIZE_VALUES = new Set(["-moz-initial", "fill", "none", "scale-down"]);

/**
 * The placeholder style Next.js' getImgProps gives an image still loading:
 * the blur SVG for `placeholder="blur"` (in development, a `/_next/image`
 * blur URL from a static import as-is), or a `data:image/` placeholder as-is,
 * sized and positioned like the image's object-fit and object-position.
 * Undefined once loaded, without a placeholder, or for an unsafe URL.
 */
export function getBlurPlaceholderStyle({
  placeholder,
  blurDataURL,
  blurWidth,
  blurHeight,
  width,
  height,
  style,
}: {
  placeholder?: string;
  blurDataURL?: string;
  blurWidth?: number;
  blurHeight?: number;
  width?: number;
  height?: number;
  style?: React.CSSProperties;
}): React.CSSProperties | undefined {
  let backgroundImage: string | undefined;
  if (placeholder === "blur") {
    const devBlurURL =
      __isDev && blurDataURL?.startsWith("/") && !blurDataURL.startsWith("//")
        ? sanitizeCssUrl(blurDataURL)
        : undefined;
    const blur = devBlurURL ?? (blurDataURL ? sanitizeBlurDataURL(blurDataURL) : undefined);
    if (!blur) return undefined;
    backgroundImage = devBlurURL
      ? `url("${devBlurURL}")`
      : `url("data:image/svg+xml;charset=utf-8,${getImageBlurSvg({
          widthInt: width,
          heightInt: height,
          blurWidth,
          blurHeight,
          blurDataURL: blur,
          objectFit: style?.objectFit,
        })}")`;
  } else if (placeholder?.startsWith("data:image/")) {
    const dataURL = sanitizeBlurDataURL(placeholder);
    if (!dataURL) return undefined;
    backgroundImage = `url("${dataURL}")`;
  } else {
    return undefined;
  }
  const objectFit = style?.objectFit;
  return {
    backgroundSize:
      objectFit && !INVALID_BACKGROUND_SIZE_VALUES.has(objectFit)
        ? objectFit
        : objectFit === "fill"
          ? "100% 100%"
          : "cover",
    backgroundPosition: (style?.objectPosition as string | undefined) || "50% 50%",
    backgroundRepeat: "no-repeat",
    backgroundImage,
  };
}

/**
 * Responsive image widths matching Next.js's device sizes config.
 * These are the breakpoints used for srcSet generation.
 * Configurable via `images.deviceSizes` in next.config.js.
 */
export const RESPONSIVE_WIDTHS = [...__imageDeviceSizes].sort((left, right) => left - right);
const ALL_IMAGE_WIDTHS = [...RESPONSIVE_WIDTHS, ...__imageSizes].sort(
  (left, right) => left - right,
);

function extractLocalDeploymentId(src: string): { src: string; deploymentId?: string } {
  let deploymentId = getDeploymentId();
  if (!src.startsWith("/") || src.startsWith("//")) return { src, deploymentId };

  const queryIndex = src.indexOf("?");
  if (queryIndex === -1) return { src, deploymentId };

  const params = new URLSearchParams(src.slice(queryIndex + 1));
  const sourceDeploymentId = params.get("dpl");
  if (!sourceDeploymentId) return { src, deploymentId };

  deploymentId = sourceDeploymentId;
  params.delete("dpl");
  const remainingQuery = params.toString();
  return {
    src: src.slice(0, queryIndex) + (remainingQuery ? `?${remainingQuery}` : ""),
    deploymentId,
  };
}

// Next.js defaults `images.path` to `${basePath}/_next/image` and appends a
// slash when trailingSlash is enabled. The `url` source is never prefixed.
const __imageEndpoint = `${process.env.__NEXT_ROUTER_BASEPATH ?? ""}/_next/image${
  process.env.__VINEXT_TRAILING_SLASH === "true" ? "/" : ""
}`;

/**
 * Parse a `quality` prop like Next.js's `getInt` (shared/lib/get-img-props.ts):
 * finite numbers and digit-only strings pass, anything else becomes NaN, which
 * the default loader treats as 75.
 */
export function parseImageQuality(quality: unknown): number | undefined {
  if (quality === undefined) return undefined;
  if (typeof quality === "number") return Number.isFinite(quality) ? quality : NaN;
  if (typeof quality === "string" && /^[0-9]+$/.test(quality)) return parseInt(quality, 10);
  return NaN;
}

/**
 * Round a `quality` prop to the closest entry of `images.qualities`, as the
 * Next.js default loader does (shared/lib/find-closest-quality.ts), so the
 * URL is one the optimization endpoint accepts.
 *
 * With no list configured the prop is used as written (75 when absent). This
 * is deliberate: Next.js 16 defaults the list to `[75]` and would round every
 * quality to 75, but vinext keeps the Next.js 14/15 behaviour for an unset
 * list so migrating apps keep the qualities they ask for (see
 * ImageConfig.qualities in server/image-optimization.ts).
 */
function findClosestQuality(quality: number): number {
  const q = quality || 75;
  if (!__imageQualities?.length) return q;
  return __imageQualities.reduce(
    (prev, cur) => (Math.abs(cur - q) < Math.abs(prev - q) ? cur : prev),
    __imageQualities[0],
  );
}

/**
 * Build a `/_next/image` optimization URL.
 *
 * In production (Cloudflare Workers), the worker intercepts this path and uses
 * the Images binding to resize/transcode on the fly. In dev, the Vite dev
 * server handles it as a passthrough (serves the original file).
 */
export function imageOptimizationUrl(src: string, width: number, quality: number = 75): string {
  const q = findClosestQuality(quality);
  const source = extractLocalDeploymentId(src);
  const deploymentQuery =
    source.src.startsWith("/") && source.deploymentId ? `&dpl=${source.deploymentId}` : "";
  return `${__imageEndpoint}?url=${encodeURIComponent(source.src)}&w=${width}&q=${q}${deploymentQuery}`;
}

/**
 * Generate a srcSet string for responsive images.
 *
 * Each width points to the `/_next/image` optimization endpoint so the
 * server can resize and transcode the image.
 */
function getImageWidths(width: number): number[] {
  return [
    ...new Set(
      [width, width * 2].map(
        (targetWidth) =>
          ALL_IMAGE_WIDTHS.find((configuredWidth) => configuredWidth >= targetWidth) ??
          ALL_IMAGE_WIDTHS[ALL_IMAGE_WIDTHS.length - 1],
      ),
    ),
  ];
}

export function generateImageAttributes(
  resolveUrl: (src: string, width: number, quality?: number) => string,
  src: string,
  width: number | undefined,
  quality: number | undefined,
  sizes?: string,
  legacyLayout?: string,
): { src: string; srcSet: string; sizes?: string } {
  // next/legacy/image (client/legacy/image.tsx getWidths): "responsive" and
  // "fill" layouts always get `w` candidates, while "fixed" and "intrinsic"
  // keep 1x/2x candidates and ignore `sizes` when choosing widths.
  const legacyFluid = legacyLayout === "responsive" || legacyLayout === "fill";
  if (sizes && (!legacyLayout || legacyFluid)) {
    const viewportWidthPattern = /(^|\s)(1?\d?\d)vw/g;
    const viewportPercentages = Array.from(sizes.matchAll(viewportWidthPattern), (match) =>
      Number.parseInt(match[2], 10),
    );
    const minimumWidth =
      viewportPercentages.length > 0
        ? RESPONSIVE_WIDTHS[0] * (Math.min(...viewportPercentages) * 0.01)
        : 0;
    const candidates = ALL_IMAGE_WIDTHS.filter((candidateWidth) => candidateWidth >= minimumWidth);
    return {
      src: resolveUrl(src, candidates[candidates.length - 1], quality),
      srcSet: candidates
        .map((candidateWidth) => `${resolveUrl(src, candidateWidth, quality)} ${candidateWidth}w`)
        .join(", "),
      sizes,
    };
  }

  // No intrinsic width (e.g. `fill`): Next.js's getWidths() offers every
  // device size and defaults `sizes` to 100vw.
  if (width === undefined || legacyFluid) {
    return {
      src: resolveUrl(src, RESPONSIVE_WIDTHS[RESPONSIVE_WIDTHS.length - 1], quality),
      srcSet: RESPONSIVE_WIDTHS.map(
        (candidateWidth) => `${resolveUrl(src, candidateWidth, quality)} ${candidateWidth}w`,
      ).join(", "),
      sizes: "100vw",
    };
  }

  const widths = getImageWidths(width);
  return {
    src: resolveUrl(src, widths[widths.length - 1], quality),
    srcSet: widths
      .map((candidateWidth, index) => `${resolveUrl(src, candidateWidth, quality)} ${index + 1}x`)
      .join(", "),
    sizes,
  };
}

/**
 * Same per-width srcSet treatment as the built-in loader, but routed
 * through a user-supplied loader (the `loader` prop or `images.loaderFile`)
 * instead of the built-in /_next/image endpoint. Unlike the built-in loader,
 * `quality` is passed through as given, including `undefined`, so a custom
 * loader's own default (if any) applies, matching Next.js: the forced
 * quality=75 default is specific to the built-in loader.
 */
export function generateLoaderAttributes(
  loader: ImageLoader,
  src: string,
  width: number | undefined,
  quality: number | undefined,
  sizes?: string,
  legacyLayout?: string,
): { src: string; srcSet: string; sizes?: string } {
  return generateImageAttributes(
    (loaderSrc, loaderWidth, loaderQuality) =>
      loader({ src: loaderSrc, width: loaderWidth, quality: loaderQuality }),
    src,
    width,
    quality,
    sizes,
    legacyLayout,
  );
}

/**
 * Internal prop set only by shims/legacy-image.tsx so custom-loader srcSet
 * candidates follow next/legacy/image's layout rules instead of next/image's.
 */
export type LegacyLayoutProp = { __vinextLegacyLayout?: string };

/** Internal: also thrown by shims/image-external.tsx for next/image. */
export function missingLoaderError(src: string): Error {
  return new Error(
    `Image with src "${src}" is missing "loader" prop.` +
      "\nRead more: https://nextjs.org/docs/messages/next-image-missing-loader",
  );
}

const configuredImageLoader: ImageLoader | undefined = imageLoaderFileModule.default;
/** `images.loaderFile` is set, so `configuredImageLoader` must be its default export. */
const __hasImageLoaderFile = process.env.__VINEXT_IMAGE_LOADER_FILE === "true";

/**
 * next/image only (next/legacy/image never evaluates `images.loaderFile`):
 * fall back to the configured loader file when no `loader` prop is given.
 * Ported from the loader checks at the top of Next.js's getImgProps.
 */
export function withConfiguredLoader(props: ImageProps): ImageProps {
  if (__hasImageLoaderFile && typeof configuredImageLoader === "undefined") {
    throw new Error(
      "images.loaderFile detected but the file is missing default export.\nRead more: https://nextjs.org/docs/messages/invalid-images-config",
    );
  }
  const loader = props.loader || configuredImageLoader;
  if (!loader && __customImageLoader) {
    const { src } = props;
    throw missingLoaderError(
      typeof src === "string" ? src : ("default" in src ? src.default : src).src,
    );
  }
  return loader === props.loader ? props : { ...props, loader };
}

/** Sources Next.js always treats as unoptimized (empty, data: and blob:). */
export function isInlineSrc(src: string): boolean {
  return !src || src.startsWith("data:") || src.startsWith("blob:");
}

/**
 * getImageProps — for advanced use cases (picture elements, background images).
 * Returns the props that would be passed to the underlying <img> element.
 */
export function getImageProps(imagePropsInput: ImageProps): { props: ImgProps } {
  const props = withConfiguredLoader(imagePropsInput);
  const {
    src: srcProp,
    alt,
    width,
    height,
    fill,
    preload: _preload,
    priority,
    quality: _quality,
    placeholder,
    blurDataURL: blurDataURLProp,
    loader,
    sizes,
    className,
    style,
    onLoad: _onLoad,
    onLoadingComplete: _onLoadingComplete,
    unoptimized: _unoptimized,
    overrideSrc,
    loading,
    ...rest
  } = props;
  delete (rest as { srcSet?: unknown }).srcSet;

  const {
    src,
    width: imgWidth,
    height: imgHeight,
    blurDataURL: imgBlurDataURL,
    blurWidth,
    blurHeight,
  } = resolveImageSource({ src: srcProp, width, height, blurDataURL: blurDataURLProp });
  const shouldPreload = _preload === true || priority === true;

  if (_unoptimized === true || __globallyUnoptimized || isInlineSrc(src)) {
    // As in the component path, unoptimized images never reach the server-side
    // optimizer, so remote URL validation is intentionally unnecessary.
    const renderedSrc = overrideSrc || src;
    const blurStyle = getBlurPlaceholderStyle({
      placeholder,
      blurDataURL: imgBlurDataURL,
      blurWidth,
      blurHeight,
      width: imgWidth,
      height: imgHeight,
      style,
    });
    const imageProps: ImgProps = {
      src: renderedSrc,
      alt,
      width: fill ? undefined : imgWidth,
      height: fill ? undefined : imgHeight,
      loading: priority ? "eager" : shouldPreload ? loading : (loading ?? "lazy"),
      fetchPriority: priority ? ("high" as const) : undefined,
      decoding: "async" as const,
      className,
      style: fill ? getFillStyle(style, blurStyle) : { ...blurStyle, ...style },
      ...rest,
      sizes: sizes ?? (fill ? "100vw" : undefined),
      srcSet: undefined,
    };
    return { props: Object.assign(imageProps, { "data-nimg": fill ? "fill" : "1" }) };
  }

  // A custom loader (the `loader` prop, or `images.loaderFile` from
  // next.config.js when no per-image prop was given) gets `quality` as given,
  // including `undefined` — only the built-in /_next/image loader below
  // defaults it to 75.
  const imgQuality = parseImageQuality(_quality);

  // Validate remote URLs against configured patterns. As in the component
  // path (and Next.js's default loader), a custom loader owns the URL, so
  // remotePatterns don't apply to it.
  let blockedInProd = false;
  if (!loader && isRemoteUrl(src)) {
    const validation = validateRemoteUrl(src);
    if (!validation.allowed) {
      if (__isDev) {
        console.warn(`[next/image] ${validation.reason}`);
      } else {
        console.error(`[next/image] ${validation.reason}`);
        blockedInProd = true;
      }
    }
  }

  let optimizedSrc: string;
  let srcSet: string | undefined;
  if (blockedInProd) {
    optimizedSrc = "";
    srcSet = undefined;
  } else if (loader) {
    const loaderAttributes = generateLoaderAttributes(
      loader,
      src,
      fill ? undefined : imgWidth,
      imgQuality,
      sizes,
    );
    optimizedSrc = overrideSrc || loaderAttributes.src;
    srcSet = loaderAttributes.srcSet;
  } else {
    // For local images (no loader, not remote), route through the
    // optimization endpoint. When `unoptimized` is true, bypass the
    // endpoint entirely (Next.js compat). SVG sources auto-skip unless
    // dangerouslyAllowSVG is enabled.
    const resolvedQuality = imgQuality ?? 75;
    const isSvg = isSvgUrl(src);
    const skipOpt =
      (isSvg && !__dangerouslyAllowSVG) || (isRemoteUrl(src) && !isServerOptimizedRemoteUrl(src));
    const optimizedAttributes =
      imgWidth && !fill && !skipOpt
        ? generateImageAttributes(imageOptimizationUrl, src, imgWidth, resolvedQuality, sizes)
        : null;
    optimizedSrc = skipOpt
      ? src
      : optimizedAttributes
        ? optimizedAttributes.src
        : imageOptimizationUrl(src, RESPONSIVE_WIDTHS[0], resolvedQuality);
    // Build srcSet for local images — each width points to /_next/image
    srcSet = optimizedAttributes?.srcSet;
  }

  // Blur placeholder styles — sanitize to prevent CSS injection
  const blurStyle = getBlurPlaceholderStyle({
    placeholder,
    blurDataURL: imgBlurDataURL,
    blurWidth,
    blurHeight,
    width: imgWidth,
    height: imgHeight,
    style,
  });

  const imageProps: ImgProps = {
    alt,
    width: fill ? undefined : imgWidth,
    height: fill ? undefined : imgHeight,
    loading: priority ? "eager" : shouldPreload ? loading : (loading ?? "lazy"),
    fetchPriority: priority ? ("high" as const) : undefined,
    decoding: "async" as const,
    srcSet,
    sizes: sizes ?? (fill ? "100vw" : undefined),
    // After srcSet/sizes, matching Next.js's prop order (Safari fetches `src`
    // early if React applies it first).
    src: optimizedSrc,
    className,
    style: fill ? getFillStyle(style, blurStyle) : { ...blurStyle, ...style },
    ...rest,
  };
  return { props: Object.assign(imageProps, { "data-nimg": fill ? "fill" : "1" }) };
}
