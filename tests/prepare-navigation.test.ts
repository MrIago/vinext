import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Ported from Next.js router.experimental_prepare() (vercel/next.js#101050,
// test/e2e/app-dir/prepare-navigation): prepare sends the full request now,
// the handle commits once, and a relative href resolves where it was prepared.
describe("router.experimental_prepare", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("__NEXT_PREPARE_NAVIGATION", "true");
    vi.stubGlobal("window", { location: { href: "https://app.example/hub/a" } });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("prefetches the full route now and commits once against the prepared URL", async () => {
    const { appRouterInstance: _appRouter } =
      (await import("../packages/vinext/src/shims/app-router-navigation.js")) as unknown as {
        appRouterInstance: {
          experimental_prepare?: (href: string) => {
            push(options?: object): void;
            replace(options?: object): void;
          };
          prefetch: (href: string, options?: object) => void;
          push: (href: string, options?: object) => void;
        };
      };
    expect(_appRouter.experimental_prepare).toBeTypeOf("function");
    const prefetch = vi.spyOn(_appRouter, "prefetch").mockImplementation(() => {});
    const push = vi.spyOn(_appRouter, "push").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const prepared = _appRouter.experimental_prepare!("../target");
    expect(prefetch).toHaveBeenCalledWith("https://app.example/target", { kind: "full" });

    prepared.push({ scroll: false });
    prepared.push();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("https://app.example/target", { scroll: false });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("was already committed"));
  });
});
