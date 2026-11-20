import { describe, expect, it } from "vitest";
import {
  convertCustomRouteSource,
  generateLinkTypesFile,
} from "../packages/vinext/src/typegen/link-types.js";

// Ported from Next.js typed links (`typedRoutes: true`, issue cloudflare/vinext#3075):
// packages/next/src/server/lib/router-utils/typegen.ts (generateLinkTypesFile) and
// route-types-utils.ts (convertCustomRouteSource).
const empty = {
  appRoutes: {},
  pageRoutes: {},
  redirectRoutes: {},
  rewriteRoutes: {},
  appRouteHandlerRoutes: {},
  pageApiRoutes: [],
};

describe("typed links", () => {
  it("splits static and dynamic routes into their unions", () => {
    const file = generateLinkTypesFile({
      ...empty,
      appRoutes: {
        "/": { path: "app/page.tsx" },
        "/blog/[slug]": { path: "app/blog/[slug]/page.tsx" },
        "/docs/[...parts]": { path: "app/docs/[...parts]/page.tsx" },
        "/shop/[[...filters]]": { path: "app/shop/[[...filters]]/page.tsx" },
      },
    });
    expect(file).toContain("| `/` // app/page.tsx");
    expect(file).toContain("| `/blog/${SafeSlug<T>}` // app/blog/[slug]/page.tsx");
    expect(file).toContain("| `/docs/${CatchAllSlug<T>}`");
    expect(file).toContain("| `/shop/${OptionalCatchAllSlug<T>}`");
    expect(file).toContain("declare module 'next/link'");
    expect(file).toContain("declare module 'next/navigation'");
    expect(file).toContain("declare module 'next/form'");
  });

  it("falls back to string & {} without any route", () => {
    expect(generateLinkTypesFile(empty)).toContain("type RouteImpl<T> = string & {}");
  });

  it("converts redirect and rewrite sources like Next.js", () => {
    expect(convertCustomRouteSource("/old/:slug")).toEqual(["/old/[slug]"]);
    expect(convertCustomRouteSource("/docs/:path*")).toEqual(["/docs/[[...path]]"]);
    expect(convertCustomRouteSource("/docs/:path+")).toEqual(["/docs/[...path]"]);
    expect(convertCustomRouteSource("/blog/:id(\\d+)")).toEqual([]);
  });
});
