import { test, expect } from "@playwright/test";

test("dev mode self-hosts Google fonts", async ({ page, request }) => {
  await page.goto("/font-google-test");
  const html = await page.content();
  expect(html).not.toContain("fonts.googleapis.com");
  expect(html).toMatch(/<style data-vinext-fonts/);

  const m = html.match(/href="(\/[^"]*_vinext_fonts\/[^"]+\.woff2)"/);
  expect(m).not.toBeNull();
  const res = await request.get(m![1]);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("font/woff2");
  expect((await res.body()).byteLength).toBeGreaterThan(1000);

  // The @font-face rules are served as an external stylesheet (issue #1897),
  // not inlined into the HTML — the dev middleware serves it from the cache.
  const cssLink = html.match(
    /<link rel="stylesheet"[^>]*href="(\/[^"]*_vinext_fonts\/[^"]+\.css)"/,
  );
  expect(cssLink).not.toBeNull();
  const cssRes = await request.get(cssLink![1]);
  expect(cssRes.status()).toBe(200);
  // Next.js serves static CSS through `send`, which appends the mime
  // charset to text types ("text/css; charset=UTF-8"), so match the type
  // and allow a charset parameter.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/serve-static.ts
  expect(cssRes.headers()["content-type"]).toMatch(/^text\/css(?:;\s*charset=utf-8)?$/i);
  expect(await cssRes.text()).toContain("@font-face");
});
