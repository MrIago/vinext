import { expect, test, type Page, type Response } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";
import {
  buildTempApp,
  removeTempApp,
  serveTempApp,
  writeTempApp,
  type TempApp,
} from "./temp-app-fixture";

// Ported from Next.js:
// test/e2e/app-dir/segment-cache/app-shell-root-params/app-shell-root-params.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/app-shell-root-params/app-shell-root-params.test.ts
//
// The App Shell keeps the root params concrete, so a locale-aware shell is
// still reused across navigations, but it varies only on the root params it
// reads. The fixture's root layout reads `lang`, while `region`, also a root
// param, is read only below the shell boundary: the shell for
// /[lang]/[region]/posts varies on `lang` and is the same across `region`.
//
// The app uses Partial Prefetching, so revealing a link prefetches only the
// shared shell: each reveal is one App Shell request, or none.

type ShellPrefetch = { body: Promise<string>; url: string };

function trackAppShellPrefetches(page: Page): ShellPrefetch[] {
  const prefetches: ShellPrefetch[] = [];
  page.on("response", (response: Response) => {
    const headers = response.request().headers();
    if (headers["x-vinext-rsc-render-mode"] !== "prefetch-app-shell") return;
    prefetches.push({ body: response.text(), url: response.url() });
  });
  return prefetches;
}

test.describe("App Shell varies only on the root params it reads", () => {
  test.setTimeout(180_000);
  let fixtureRoot = "";
  let app: TempApp;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    fixtureRoot = await writeTempApp("app-shell-root-params");
    await buildTempApp(fixtureRoot);
    app = await serveTempApp(fixtureRoot);
  });

  test.afterAll(async () => {
    await app?.close();
    if (fixtureRoot) await removeTempApp(fixtureRoot);
  });

  test("reuses the shell across an unread root param, but refetches across a read one", async ({
    page,
  }) => {
    // Start on the one statically-generated route.
    await page.goto(`${app.baseUrl}/en/us`);
    await waitForAppRouterHydration(page);
    const prefetches = trackAppShellPrefetches(page);

    // Prime the shared shell for /en/uk/posts. Its render reads `lang` ('en')
    // but not `region`.
    await page.locator('input[data-link-accordion="/en/uk/posts/1"]').click();
    await expect.poll(() => prefetches.length).toBe(1);
    const englishShell = await prefetches[0]!.body;
    expect(englishShell).toContain("Shell lang: en");
    expect(englishShell).toContain("App shell for posts");
    expect(englishShell).not.toContain("Post 1 for region");

    // /en/gb/posts/1: the same lang, another region. The shell doesn't read
    // `region`, so the one cached for /en/uk is reused: nothing is prefetched.
    await page.locator('input[data-link-accordion="/en/gb/posts/1"]').click();
    await expect(page.locator('a[href="/en/gb/posts/1"]')).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(prefetches).toHaveLength(1);

    // /fr/uk/posts/1: another lang. The shell reads `lang`, so it isn't
    // reused, and a fresh shell is prefetched.
    await page.locator('input[data-link-accordion="/fr/uk/posts/1"]').click();
    await expect.poll(() => prefetches.length).toBe(2);
    const frenchShell = await prefetches[1]!.body;
    expect(frenchShell).toContain("App shell for posts");
    expect(frenchShell).toContain("Shell lang: fr");
  });
});
