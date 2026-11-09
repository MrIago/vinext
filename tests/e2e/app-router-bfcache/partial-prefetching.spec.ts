import { expect, test } from "@playwright/test";
import type { Page, Response } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

// Cache Components prefetches with Partial Prefetching. The routes under
// /partial-prefetching opt in with `export const prefetch = "partial"`: a
// <Link>'s automatic prefetch gets the route's App Shell, `prefetch={true}` a
// partial prefetch up to `prefetch()`, and `prefetch="navigation"` one up to
// `navigation()`. None of them carries the page's dynamic data, which the
// navigation renders while it shows the prefetched shell.
//
// Ported from Next.js:
// test/e2e/app-dir/segment-cache/prefetch-app-shell/prefetch-app-shell.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/prefetch-app-shell/prefetch-app-shell.test.ts
// test/e2e/app-dir/segment-cache/prefetch-partial-rsc/prefetch-partial-rsc.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/prefetch-partial-rsc/prefetch-partial-rsc.test.ts
// test/e2e/app-dir/static-to-partial-rsc/static-to-partial-rsc.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/static-to-partial-rsc/static-to-partial-rsc.test.ts

const INDEX = "/partial-prefetching";

type PrefetchRecord = { body: string; mode: string | undefined; staticShell: string | null };

function recordPrefetches(page: Page, pathname: string): PrefetchRecord[] {
  const records: PrefetchRecord[] = [];
  page.on("response", async (response: Response) => {
    const request = response.request();
    if (!isAppRouterRscRequestForPath(request, pathname)) return;
    if (request.headers()["next-router-prefetch"] !== "1") return;
    records.push({
      body: await response.text().catch(() => ""),
      mode: request.headers()["x-vinext-rsc-render-mode"],
      staticShell: response.headers()["x-vinext-static-shell"] ?? null,
    });
  });
  return records;
}

async function openIndex(page: Page): Promise<void> {
  await page.goto(INDEX);
  await waitForAppRouterHydration(page);
  // Marks the document, so a navigation that falls back to a document load
  // shows up.
  await page.evaluate(() => {
    (window as unknown as { __beforeNavigation: boolean }).__beforeNavigation = true;
  });
}

async function revealLink(page: Page, href: string): Promise<void> {
  await page.locator(`input[data-link-accordion="${href}"]`).check();
  await expect(page.locator(`a[href="${href}"]`)).toBeVisible();
}

async function expectSameDocument(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => (window as unknown as { __beforeNavigation?: boolean }).__beforeNavigation,
    ),
  ).toBe(true);
}

test.describe("Partial Prefetching", () => {
  test.beforeEach(() => {
    test.skip(
      test.info().project.name !== "app-router-bfcache-prod",
      "Links only prefetch in production builds",
    );
  });

  test("a Link's automatic prefetch, hover included, gets only the App Shell", async ({ page }) => {
    const href = `${INDEX}/shell`;
    const prefetches = recordPrefetches(page, href);
    await openIndex(page);

    await revealLink(page, href);
    await page.locator(`a[href="${href}"]`).hover();
    await expect.poll(() => prefetches.length).toBeGreaterThan(0);
    // Hovering doesn't upgrade the prefetch past the shell.
    await page.waitForTimeout(500);

    expect(prefetches.map((prefetch) => prefetch.mode)).toEqual(["prefetch-app-shell"]);
    const [shell] = prefetches;
    expect(shell!.staticShell).toBe("partial");
    expect(shell!.body).toContain("Static shell");
    expect(shell!.body).not.toContain("Prefetch content");
    expect(shell!.body).not.toContain("Navigation content");
    expect(shell!.body).not.toContain("Caller:");
  });

  test("prefetch={true} gets a partial prefetch up to prefetch()", async ({ page }) => {
    const href = `${INDEX}/partial`;
    const prefetches = recordPrefetches(page, href);
    await openIndex(page);

    await revealLink(page, href);
    await expect.poll(() => prefetches.length).toBe(1);

    const [partial] = prefetches;
    expect(partial!.mode).toBe("prefetch-partial");
    expect(partial!.staticShell).toBe("partial");
    expect(partial!.body).toContain("Static shell");
    expect(partial!.body).toContain("Prefetch content");
    expect(partial!.body).not.toContain("Navigation content");
    expect(partial!.body).not.toContain("Caller:");
  });

  test('prefetch="navigation" gets a partial prefetch up to navigation()', async ({ page }) => {
    // A sibling URL's shallower prefetch is already cached, and can't stand in
    // for this one.
    const partialHref = `${INDEX}/partial`;
    const href = `${INDEX}/navigation`;
    const partialPrefetches = recordPrefetches(page, partialHref);
    const prefetches = recordPrefetches(page, href);
    await openIndex(page);
    await revealLink(page, partialHref);
    await expect.poll(() => partialPrefetches.length).toBe(1);

    await revealLink(page, href);
    await expect.poll(() => prefetches.length).toBe(1);

    const [navigation] = prefetches;
    expect(navigation!.mode).toBe("prefetch-partial-navigation");
    expect(navigation!.body).toContain("Prefetch content");
    expect(navigation!.body).toContain("Navigation content");
    expect(navigation!.body).not.toContain("Caller:");
  });

  for (const kind of ["shell", "partial"] as const) {
    test(`a navigation shows the prefetched ${kind} at once and renders the rest`, async ({
      context,
      page,
    }) => {
      const href = `${INDEX}/${kind}`;
      const prefetches = recordPrefetches(page, href);
      await context.addCookies([
        { name: "caller", value: kind, url: new URL(INDEX, test.info().project.use.baseURL).href },
      ]);
      await openIndex(page);
      await revealLink(page, href);
      await expect.poll(() => prefetches.length).toBe(1);

      await page.locator(`a[href="${href}"]`).click();
      // The page's data takes 1.5s; the shell is up long before.
      await expect(page.locator("#ppf-static")).toHaveText("Static shell", { timeout: 1000 });
      await expect(page.locator("#caller-fallback")).toHaveText("Loading request data");
      if (kind === "partial") {
        await expect(page.locator("#prefetch-content")).toHaveText("Prefetch content");
      }
      await expect(page.locator("#caller")).toHaveText(`Caller: ${kind}`);
      await expect(page.locator("#navigation-content")).toHaveText("Navigation content");
      await expectSameDocument(page);
    });
  }

  // A route that was fully static at build and starts reading request data
  // when it regenerates gets its App Shell as partial, and the navigation
  // renders the request's data instead of reusing the stale complete shell.
  test("a static route that reads request data after revalidation renders it on navigation", async ({
    browser,
    page,
    request,
  }) => {
    const href = `${INDEX}/static-to-partial`;
    await page.goto(href);
    await expect(page.locator("#build-content")).toHaveText("Build-time content");

    expect((await request.post(`${INDEX}/revalidate`)).status()).toBe(200);
    await expect
      .poll(async () => (await (await request.get(href)).text()).includes("Caller: none"), {
        timeout: 10_000,
      })
      .toBe(true);

    for (const caller of ["first", "second"]) {
      const context = await browser.newContext();
      try {
        await context.addCookies([
          {
            name: "caller",
            value: caller,
            url: new URL(INDEX, test.info().project.use.baseURL).href,
          },
        ]);
        const callerPage = await context.newPage();
        const prefetches = recordPrefetches(callerPage, href);
        await openIndex(callerPage);
        await revealLink(callerPage, href);
        await expect.poll(() => prefetches.length).toBe(1);
        expect(prefetches[0]!.staticShell).toBe("partial");
        expect(prefetches[0]!.body).not.toContain("Build-time content");

        await callerPage.locator(`a[href="${href}"]`).click();
        await expect(callerPage.locator("#caller")).toHaveText(`Caller: ${caller}`);
        await expectSameDocument(callerPage);
      } finally {
        await context.close();
      }
    }
  });
});

// Ported from Next.js (vercel/next.js#94672): in development with Cache
// Components, navigating from a Link that asks for more than the shell to a
// route without Partial Prefetching reports that its prefetch carried the
// route's dynamic data.
// https://github.com/vercel/next.js/blob/canary/test/development/app-dir/prefetch-true-partial-warning/prefetch-true-partial-warning.test.ts
test.describe("Partial Prefetching dev warning", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "app-router-bfcache", "The warning is development-only");
  });

  test("warns about a prefetch={true} Link to a route without Partial Prefetching", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(INDEX);
    await waitForAppRouterHydration(page);

    await page.locator("#legacy-full-link").click();
    await expect(page.locator("#legacy-page")).toHaveText("Legacy full prefetch");
    await expect
      .poll(() =>
        errors.find((error) => error.includes("encountered dynamic data during prefetching")),
      )
      .toContain('"/partial-prefetching-legacy"');
  });

  test("stays quiet for a prefetch={true} Link to a Partial Prefetching route", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(INDEX);
    await waitForAppRouterHydration(page);

    await revealLink(page, `${INDEX}/partial`);
    await page.locator(`a[href="${INDEX}/partial"]`).click();
    await expect(page.locator("#ppf-static")).toHaveText("Static shell");
    await expect(page.locator("#caller")).toHaveText("Caller: none");
    expect(errors.filter((error) => error.includes("during prefetching"))).toEqual([]);
  });
});
