import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Next.js re-exports the runtime's global URLPattern from `next/server`:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/spec-extension/url-pattern.ts
// Node only ships a global URLPattern from v23.8.0, so on Node 22 the shim
// has to fail with an actionable error instead of "is not a constructor".
describe("next/server URLPattern", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "URLPattern");

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "URLPattern", original);
    else delete (globalThis as { URLPattern?: unknown }).URLPattern;
    vi.resetModules();
  });

  it("throws a clear error when constructed without a global URLPattern", async () => {
    delete (globalThis as { URLPattern?: unknown }).URLPattern;
    vi.resetModules();
    const { URLPattern } = await import("../packages/vinext/src/shims/server.js");

    expect(() => new URLPattern({ pathname: "/:id" })).toThrow(/Node\.js >= 23\.8/);
  });

  it("re-exports the native URLPattern when the runtime provides one", async () => {
    class FakeURLPattern {}
    Object.defineProperty(globalThis, "URLPattern", {
      value: FakeURLPattern,
      configurable: true,
      writable: true,
    });
    vi.resetModules();
    const { URLPattern } = await import("../packages/vinext/src/shims/server.js");

    expect(URLPattern).toBe(FakeURLPattern);
  });
});
