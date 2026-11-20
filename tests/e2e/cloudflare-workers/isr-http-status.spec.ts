import { expect, test } from "@playwright/test";

// The runtime ISR side of Next.js's prerendered-http-status-codes test
// (vercel/next.js#99078), on Workers: an entry written at request time stores
// the status of a notFound() or redirect() a Suspense boundary caught, and a
// redirect's location, for the requests it serves.
// https://github.com/vercel/next.js/blob/canary/test/e2e/prerendered-http-status-codes/index.test.ts
for (const [kind, status, location] of [
  ["not-found", 404, undefined],
  ["redirect", 307, "/"],
] as const) {
  test(`a cached ${kind} a Suspense boundary caught answers with ${status}`, async ({
    baseURL,
    request,
  }) => {
    const url = `${baseURL}/isr-http-status/${kind}?run=${Date.now()}`;
    const first = await request.get(url, { maxRedirects: 0 });
    expect(await first.text()).toContain('id="layout"');

    await expect
      .poll(async () => (await request.get(url, { maxRedirects: 0 })).headers()["x-vinext-cache"], {
        timeout: 15_000,
      })
      .toBe("HIT");
    const cached = await request.get(url, { maxRedirects: 0 });
    expect(cached.status()).toBe(status);
    expect(cached.headers()["location"]).toBe(location);
    expect(await cached.text()).toContain('id="layout"');
  });
}
