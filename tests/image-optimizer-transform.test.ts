import { describe, expect, it } from "vitest";
import {
  ImageError,
  getMaxAge,
  imageOptimizerTransform,
} from "../packages/vinext/src/shims/image-optimizer-transform.js";

// Ported from Next.js: packages/next/src/server/image-optimizer/transform.ts
// (`next/experimental/image-optimizer-transform`, issue cloudflare/vinext#3830).
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
const params = { href: "/a.svg", width: 64, quality: 75, mimeType: "" };

describe("next/experimental/image-optimizer-transform", () => {
  it("rejects a source that isn't an image", async () => {
    await expect(
      imageOptimizerTransform(
        { buffer: Buffer.from("hello"), contentType: null, cacheControl: null, etag: "e" },
        params,
      ),
    ).rejects.toBeInstanceOf(ImageError);
  });

  it("rejects SVG unless dangerouslyAllowSVG is set", async () => {
    const upstream = { buffer: svg, contentType: "image/svg+xml", cacheControl: null, etag: "e" };
    await expect(imageOptimizerTransform(upstream, params)).rejects.toMatchObject({
      statusCode: 400,
    });
    const passed = await imageOptimizerTransform(upstream, params, { dangerouslyAllowSVG: true });
    expect(passed).toMatchObject({ contentType: "image/svg+xml", optimized: false, etag: "e" });
  });

  it("reads max-age like Next.js' getMaxAge", () => {
    expect(getMaxAge("public, s-maxage=60, max-age=10")).toBe(60);
    expect(getMaxAge('max-age="30"')).toBe(30);
    expect(getMaxAge(null)).toBe(0);
  });
});
