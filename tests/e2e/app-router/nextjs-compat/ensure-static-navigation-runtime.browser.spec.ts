import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  buildTempApp,
  removeTempApp,
  serveTempApp,
  writeTempApp,
  type TempApp,
} from "./temp-app-fixture";

// Ported from Next.js:
// test/e2e/app-dir/ensure-static-navigation-runtime/ensure-static-navigation-runtime.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/ensure-static-navigation-runtime/ensure-static-navigation-runtime.test.ts
// and its Partial Prefetching variant,
// ensure-static-navigation-runtime.partial-prefetching.test.ts, which runs the
// same suite with `partialPrefetching: true`.

const NEXT_CONFIG = (partialPrefetching: boolean) => `const nextConfig = {
  cacheComponents: true,
  partialPrefetching: ${partialPrefetching},
};

export default nextConfig;
`;

type Kind = "html" | "rsc";

for (const partialPrefetching of [false, true]) {
  test.describe(`ensureStatic = "navigation" - runtime behavior${partialPrefetching ? " (Partial Prefetching)" : ""}`, () => {
    test.setTimeout(180_000);
    let fixtureRoot = "";
    let app: TempApp;

    test.beforeAll(async () => {
      test.setTimeout(180_000);
      fixtureRoot = await writeTempApp("ensure-static-navigation-runtime", {
        "next.config.ts": NEXT_CONFIG(partialPrefetching),
      });
      await buildTempApp(fixtureRoot);
      app = await serveTempApp(fixtureRoot);
    });

    test.afterAll(async () => {
      await app?.close();
      if (fixtureRoot) await removeTempApp(fixtureRoot);
    });

    /** Four requests get the same static response, timestamp included. */
    async function expectSameStaticResponseForMultipleRequests(
      request: APIRequestContext,
      href: string,
      kind: Kind = "html",
    ): Promise<string> {
      const responses = new Set<string>();
      const headers: Record<string, string> = kind === "rsc" ? { rsc: "1" } : {};
      for (let i = 0; i < 4; i++) {
        const response = await request.get(`${app.baseUrl}${href}`, { headers });
        const text = await response.text();
        expect(text).not.toBe("");
        responses.add(text);
      }
      expect([...responses]).toHaveLength(1);
      return [...responses][0]!;
    }

    function collectBrowserErrors(page: Page): string[] {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "warning" || message.type() === "error") {
          errors.push(message.text());
        }
      });
      page.on("pageerror", (error) => errors.push(error.message));
      return errors;
    }

    test.describe("pages without params", () => {
      test("basic", async ({ page, request }) => {
        const href = "/default/no-params";
        const response = await expectSameStaticResponseForMultipleRequests(request, href);
        expect(response).toContain('<p id="static-content">Static content</p>');

        const errors = collectBrowserErrors(page);
        await page.goto(`${app.baseUrl}${href}`);
        await expect(page.locator("#static-content")).toHaveText("Static content");
        expect(errors).toEqual([]);
      });

      test("browser bailout", async ({ page, request }) => {
        const href = "/default/browser-bailout";
        const response = await expectSameStaticResponseForMultipleRequests(request, href);
        // Browser-only content isn't in the static document.
        expect(response).toContain("Fallback for browser-only content");
        expect(response).not.toContain('id="browser-content"');

        const errors = collectBrowserErrors(page);
        await page.goto(`${app.baseUrl}${href}`);
        await expect(page.locator("#browser-content")).toHaveText("Browser-only content");
        expect(errors).toEqual([]);
      });

      test("client-only IO", async ({ page, request }) => {
        const href = "/default/client-io";
        const response = await expectSameStaticResponseForMultipleRequests(request, href);
        // Client-only IO doesn't run while serving a static prerender.
        expect(response).toContain("Fallback for client-only IO");
        expect(response).not.toContain('id="client-io"');

        const errors = collectBrowserErrors(page);
        await page.goto(`${app.baseUrl}${href}`);
        await expect(page.locator("#client-io")).toHaveText("Client-only IO");
        expect(errors).toEqual([]);
      });
    });

    test.describe("page with static params", () => {
      const cases: Array<[label: string, slug: string, kind: Kind]> = [
        [
          "serves static results for params that were prerendered at build",
          "prerendered-1",
          "html",
        ],
        ["serves static results for params that were prerendered at build", "prerendered-2", "rsc"],
        [
          "serves blocking static results for params that were not prerendered at build",
          "not-prerendered-1",
          "html",
        ],
        [
          "serves blocking static results for params that were not prerendered at build",
          "not-prerendered-2",
          "rsc",
        ],
      ];
      for (const [label, slug, kind] of cases) {
        test(`${label} - slug: ${slug} - ${kind}`, async ({ page, request }) => {
          const href = `/default/static-params/${slug}`;
          const response = await expectSameStaticResponseForMultipleRequests(request, href, kind);
          const expected = `Slug: ${slug}`;
          // Not a fallback and a resume: the param is in the first response.
          expect(response).toContain(expected);

          const errors = collectBrowserErrors(page);
          await page.goto(`${app.baseUrl}${href}`);
          await expect(page.locator("#slug")).toHaveText(expected);
          expect(errors).toEqual([]);
        });
      }
    });

    test.describe("page with root params", () => {
      const cases: Array<[label: string, lang: string, kind: Kind]> = [
        ["serves static results for params that were prerendered at build", "en", "html"],
        ["serves static results for params that were prerendered at build", "pl", "rsc"],
        ["serves static results for params that were not prerendered at build", "de", "html"],
        ["serves static results for params that were not prerendered at build", "jp", "rsc"],
      ];
      for (const [label, lang, kind] of cases) {
        test(`${label} - lang: ${lang} - ${kind}`, async ({ page, request }) => {
          const href = `/with-root-param/${lang}`;
          const response = await expectSameStaticResponseForMultipleRequests(request, href, kind);
          expect(response).toContain(`Lang: ${lang}`);

          const errors = collectBrowserErrors(page);
          await page.goto(`${app.baseUrl}${href}`);
          await expect(page.locator("#lang")).toHaveText(`Lang: ${lang}`);
          expect(errors).toEqual([]);
        });
      }
    });
  });
}
