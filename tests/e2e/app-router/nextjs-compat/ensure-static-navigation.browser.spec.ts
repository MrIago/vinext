import { expect, test } from "@playwright/test";
import { escapeRegExp } from "../../../../packages/vinext/src/utils/regex.js";
import {
  buildTempApp,
  removeTempApp,
  serveTempAppInDev,
  writeTempApp,
  type TempApp,
} from "./temp-app-fixture";

// Ported from Next.js:
// test/e2e/app-dir/ensure-static-navigation/ensure-static-navigation.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/ensure-static-navigation/ensure-static-navigation.test.ts
//
// Next.js prerenders one page per build (`--debug-build-paths`) and reads its
// error. vinext's build reports every failing route at once, so one build
// covers them all: each disallowed page has its error in the report, and an
// allowed page none.
//
// Differences from Next.js, which validates the static shell to point at the
// data that made a page partial: vinext only tells that the prerender left
// part of the page for request time, so every such page gets the generic
// "uncached or runtime data" error, in the body's wording, without a location.
// Dev checks generateStaticParams but doesn't validate the shell yet.

const UNCACHED_OR_RUNTIME = (route: string) =>
  `Route "${route}": Next.js encountered uncached or runtime data on a route that must be fully static.`;
const MISSING_GSP = (page: string) =>
  `Page "${page}": \`ensureStatic = "navigation"\` requires an exported \`generateStaticParams()\` function.`;
const EMPTY_GSP =
  "When using Cache Components, all `generateStaticParams` functions must return at least one result";
const INCOMPLETE_GSP = (page: string) =>
  `Page "${page}": \`generateStaticParams()\` returned incomplete params.`;

/** The route pattern vinext reports a page's error under, as `  <pattern>: <error>`. */
const reportLine = (pattern: string) => new RegExp(`^  ${escapeRegExp(pattern)}: `, "m");

test.describe('ensureStatic = "navigation"', () => {
  test.describe("build", () => {
    test.setTimeout(180_000);
    let buildError = "";

    test.beforeAll(async () => {
      test.setTimeout(180_000);
      const fixtureRoot = await writeTempApp("ensure-static-navigation");
      try {
        await buildTempApp(fixtureRoot);
      } catch (error) {
        buildError = error instanceof Error ? error.message : String(error);
      } finally {
        await removeTempApp(fixtureRoot);
      }
    });

    const disallowed: Array<[name: string, pattern: string, message: string]> = [
      // dynamic data
      [
        "does not allow using uncached data despite suspense",
        "/default/uncached-data",
        UNCACHED_OR_RUNTIME("/default/uncached-data"),
      ],
      [
        "does not allow using `connection()` despite suspense",
        "/default/connection",
        UNCACHED_OR_RUNTIME("/default/connection"),
      ],
      [
        "does not allow using `connection()` despite `instant = false`",
        "/default/instant-false/connection-blocking",
        UNCACHED_OR_RUNTIME("/default/instant-false/connection-blocking"),
      ],
      [
        "does not allow using `connection()` despite suspense-above-body",
        "/suspense-above-body/connection-blocking",
        UNCACHED_OR_RUNTIME("/suspense-above-body/connection-blocking"),
      ],
      [
        "does not allow passing dynamic data to a client component that accesses it with `use()`",
        "/default/dynamic-data-passed-to-client",
        UNCACHED_OR_RUNTIME("/default/dynamic-data-passed-to-client"),
      ],
      [
        // Next.js reports it without a location; vinext's error never has one.
        "does not allow passing dynamic data to a client component, even if it's unused",
        "/default/dynamic-data-passed-to-client-unused",
        UNCACHED_OR_RUNTIME("/default/dynamic-data-passed-to-client-unused"),
      ],
      // fallback params
      [
        "does not allow using fallback params despite suspense",
        "/default/fallback-params/:slug",
        MISSING_GSP("/default/fallback-params/[slug]"),
      ],
      [
        "does not allow passing fallback params to a client component despite suspense",
        "/default/fallback-params-passed-to-client/:slug",
        MISSING_GSP("/default/fallback-params-passed-to-client/[slug]"),
      ],
      [
        "does not allow using fallback params via `useParams()` in a client segment despite suspense",
        "/default/fallback-params-client-segment/:slug",
        MISSING_GSP("/default/fallback-params-client-segment/[slug]"),
      ],
      // dynamic head: Next.js names generateMetadata() and generateViewport().
      [
        "does not allow dynamic metadata",
        "/default/dynamic-metadata",
        UNCACHED_OR_RUNTIME("/default/dynamic-metadata"),
      ],
      [
        "does not allow dynamic viewport",
        "/default/dynamic-viewport",
        UNCACHED_OR_RUNTIME("/default/dynamic-viewport"),
      ],
      // static params
      ["does not allow empty static params", "/default/static-params-empty/:slug", EMPTY_GSP],
      [
        "does not allow incomplete static params",
        "/default/static-params-incomplete/:slug/:snail",
        INCOMPLETE_GSP("/default/static-params-incomplete/[slug]/[snail]"),
      ],
      [
        "does not allow incomplete static params even if unused",
        "/default/static-params-incomplete-unused/:slug/:snail",
        INCOMPLETE_GSP("/default/static-params-incomplete-unused/[slug]/[snail]"),
      ],
      // excluded caches
      [
        "does not allow using a non-prerenderable cache despite suspense",
        "/default/excluded-caches/non-prerenderable-cache",
        UNCACHED_OR_RUNTIME("/default/excluded-caches/non-prerenderable-cache"),
      ],
      // mixed server and client holes
      [
        "does not allow using `connection()` when the page also has an allowed browser bailout",
        "/default/mixed-server-client/connection-and-browser",
        UNCACHED_OR_RUNTIME("/default/mixed-server-client/connection-and-browser"),
      ],
      [
        "does not allow using `connection()` when the page also has an allowed `useSearchParams()`",
        "/default/mixed-server-client/connection-and-use-search-params",
        UNCACHED_OR_RUNTIME("/default/mixed-server-client/connection-and-use-search-params"),
      ],
      [
        "does not allow using `connection()` when the page also has an allowed `use(io())`",
        "/default/mixed-server-client/connection-and-use-io",
        UNCACHED_OR_RUNTIME("/default/mixed-server-client/connection-and-use-io"),
      ],
    ];

    for (const [name, pattern, message] of disallowed) {
      test(name, () => {
        expect(buildError).toMatch(reportLine(pattern));
        expect(buildError).toContain(message);
      });
    }

    const allowed: Array<[name: string, pattern: string]> = [
      ["allows using static params with suspense", "/default/static-params/:slug"],
      ["allows using static params without suspense", "/default/static-params-blocking/:slug"],
      ["allows using root params without suspense", "/with-root-param/:lang"],
      ["allows using a non-shell cache with suspense", "/default/excluded-caches/non-shell-cache"],
      ["allows `use(browser())` with suspense", "/default/use-browser"],
      [
        "allows blocking `use(browser())` with suspense-above-body",
        "/suspense-above-body/use-browser-blocking",
      ],
      ["allows `use(io())` with suspense", "/default/use-io"],
    ];

    for (const [name, pattern] of allowed) {
      test(name, () => {
        // The build fails for the pages above, so it has a report.
        expect(buildError).toContain("Prerender failed");
        expect(buildError).not.toMatch(reportLine(pattern));
      });
    }

    // Next.js marks this one [FAILING] too: `instant = false` doesn't yet
    // allow blocking the root with browser-only data.
    test.fixme("allows blocking `use(browser())` with `instant = false`", () => {
      expect(buildError).not.toMatch(reportLine("/default/instant-false/use-browser-blocking"));
    });

    // A client hole without Suspense isn't specific to ensureStatic in
    // Next.js, which reports it as a blocking prerender.
    test.fixme("does not allow `use(io())` without suspense", () => {
      expect(buildError).toMatch(reportLine("/default/blocking-use-io"));
    });
  });

  test.describe("dev", () => {
    test.setTimeout(120_000);
    let fixtureRoot = "";
    let app: TempApp;

    test.beforeAll(async () => {
      test.setTimeout(120_000);
      fixtureRoot = await writeTempApp("ensure-static-navigation");
      app = await serveTempAppInDev(fixtureRoot);
    });

    test.afterAll(async () => {
      await app?.close();
      if (fixtureRoot) await removeTempApp(fixtureRoot);
    });

    const rejected: Array<[name: string, route: string, message: string]> = [
      [
        "does not allow using fallback params despite suspense",
        "/default/fallback-params/123",
        MISSING_GSP("/default/fallback-params/[slug]"),
      ],
      [
        "does not allow passing fallback params to a client component despite suspense",
        "/default/fallback-params-passed-to-client/123",
        MISSING_GSP("/default/fallback-params-passed-to-client/[slug]"),
      ],
      [
        "does not allow using fallback params via `useParams()` in a client segment despite suspense",
        "/default/fallback-params-client-segment/123",
        MISSING_GSP("/default/fallback-params-client-segment/[slug]"),
      ],
      ["does not allow empty static params", "/default/static-params-empty/123", EMPTY_GSP],
      [
        "does not allow incomplete static params",
        "/default/static-params-incomplete/123/foo",
        INCOMPLETE_GSP("/default/static-params-incomplete/[slug]/[snail]"),
      ],
      [
        "does not allow incomplete static params even if unused",
        "/default/static-params-incomplete-unused/123/foo",
        INCOMPLETE_GSP("/default/static-params-incomplete-unused/[slug]/[snail]"),
      ],
    ];

    for (const [name, route, message] of rejected) {
      test(name, async ({ request }) => {
        const response = await request.get(`${app.baseUrl}${route}`);
        expect(response.status()).toBe(500);
        const body = await response.text();
        // The dev error page may escape the message as HTML.
        expect([message, escapeHtml(message)].some((text) => body.includes(text))).toBe(true);
      });
    }

    for (const route of [
      "/default/static-params/123",
      "/default/static-params-blocking/123",
      "/with-root-param/en",
    ]) {
      test(`allows ${route}`, async ({ request }) => {
        const response = await request.get(`${app.baseUrl}${route}`);
        expect(response.status()).toBe(200);
      });
    }
  });
});

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}
