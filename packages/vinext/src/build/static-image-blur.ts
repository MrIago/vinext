/**
 * The blur placeholder of a statically imported image, as Next.js'
 * next-image-loader computes it: an image of at most 8px on its longer side,
 * inlined as a data URL at build time. In development the image-imports
 * plugin points it at the `/_next/image` URL of the blur size instead, which
 * the dev server answers on demand so startup stays fast.
 *
 * Ported from Next.js: packages/next/src/build/webpack/loaders/next-image-loader/blur.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack/loaders/next-image-loader/blur.ts
 */

import { isAnimatedImage } from "../server/image-animation.js";
import { ImageSourceReader } from "../server/image-source-reader.js";
import { loadSharp, optimizeImageWithSharp } from "../server/image-sharp.js";

const BLUR_IMG_SIZE = 8;
export const BLUR_QUALITY = 70;
/** Formats Next.js makes a blur placeholder for. */
const VALID_BLUR_EXT = new Set(["jpeg", "png", "webp", "avif"]);

export type StaticImageBlur = {
  blurDataURL?: string;
  blurWidth: number;
  blurHeight: number;
};

async function isAnimated(content: Uint8Array): Promise<boolean> {
  const reader = new ImageSourceReader(new Response(new Uint8Array(content)).body!, Infinity);
  try {
    return await isAnimatedImage(reader);
  } finally {
    reader.cancel();
  }
}

/** The blur size: the image shrunk to 8px on its longer side, at least 1px. */
function blurSize(imageSize: { width: number; height: number }): {
  blurWidth: number;
  blurHeight: number;
} {
  if (imageSize.width >= imageSize.height) {
    return {
      blurWidth: BLUR_IMG_SIZE,
      blurHeight: Math.max(Math.round((imageSize.height / imageSize.width) * BLUR_IMG_SIZE), 1),
    };
  }
  return {
    blurWidth: Math.max(Math.round((imageSize.width / imageSize.height) * BLUR_IMG_SIZE), 1),
    blurHeight: BLUR_IMG_SIZE,
  };
}

let warnedMissingSharp = false;

/**
 * The blur placeholder of a static image import. `extension` is the
 * file's (`jpg` already read as `jpeg`); the app's `sharp`, from `root`,
 * shrinks it. Without sharp the blur size is still reported but there is no
 * data URL, and the build warns once, where Next.js (which ships sharp) has
 * one. Animated images and other formats get no blur, as in Next.js.
 */
export async function getStaticImageBlur(
  content: Uint8Array,
  extension: string,
  imageSize: { width: number; height: number },
  { isDev, root }: { isDev: boolean; root: string },
): Promise<StaticImageBlur> {
  if (!VALID_BLUR_EXT.has(extension) || !imageSize.width || !imageSize.height) {
    return { blurWidth: 0, blurHeight: 0 };
  }
  if (await isAnimated(content)) return { blurWidth: 0, blurHeight: 0 };
  const { blurWidth, blurHeight } = blurSize(imageSize);
  // The dev server makes the placeholder on request (devStaticImageBlurDataURL).
  if (isDev) return { blurWidth, blurHeight };
  const sharp = await loadSharp([root]);
  if (!sharp) {
    if (!warnedMissingSharp) {
      warnedMissingSharp = true;
      console.warn(
        "[vinext] Statically imported images get no blurDataURL because `sharp` is not installed. " +
          'Install it for placeholder="blur" as in Next.js: npm install sharp',
      );
    }
    return { blurWidth, blurHeight };
  }
  const resized = await optimizeImageWithSharp(sharp, {
    buffer: content,
    contentType: `image/${extension}`,
    width: blurWidth,
    height: blurHeight,
    quality: BLUR_QUALITY,
  });
  return {
    blurDataURL: `data:image/${extension};base64,${resized.data.toString("base64")}`,
    blurWidth,
    blurHeight,
  };
}
