/**
 * `prefetch()` and `navigation()` from next/cache, the Cache Components render
 * stage boundaries.
 *
 * Ported from Next.js: packages/next/src/server/request/cache-stages.ts and
 * test/e2e/app-dir/segment-cache/prefetch-api, navigation-api
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/request/cache-stages.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  cacheLife,
  MemoryCacheHandler,
  navigation,
  prefetch,
  setCacheHandler,
  unstable_cache,
} from "../packages/vinext/src/shims/cache.js";
import { registerCachedFunction } from "../packages/vinext/src/shims/cache-runtime.js";
import { workUnitAsyncStorage } from "../packages/vinext/src/shims/internal/work-unit-async-storage.js";
import {
  createPprFallbackShellState,
  preparePprFallbackShellFinalRender,
  runWithPprFallbackShellState,
  type PprFallbackShellPrefetchStage,
} from "../packages/vinext/src/shims/ppr-fallback-shell.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(promise: Promise<unknown>): Promise<"resolved" | "pending"> {
  return Promise.race([
    promise.then(() => "resolved" as const),
    delay(20).then(() => "pending" as const),
  ]);
}

function createShell(options: {
  isRuntimePrefetch?: boolean;
  prefetchStage?: PprFallbackShellPrefetchStage;
}) {
  const state = createPprFallbackShellState({
    fallbackParamNames: [],
    routePattern: "/page",
    ...options,
  });
  preparePprFallbackShellFinalRender(state);
  return state;
}

const previousCacheComponents = process.env.__NEXT_CACHE_COMPONENTS;

beforeEach(() => {
  process.env.__NEXT_CACHE_COMPONENTS = "true";
});

afterEach(() => {
  if (previousCacheComponents === undefined) delete process.env.__NEXT_CACHE_COMPONENTS;
  else process.env.__NEXT_CACHE_COMPONENTS = previousCacheComponents;
});

describe("prefetch() and navigation() render stages", () => {
  it("resolve on a request", async () => {
    expect(await settle(prefetch())).toBe("resolved");
    expect(await settle(navigation())).toBe("resolved");
  });

  it("resolve in a static shell, which holds the whole static prerender", async () => {
    const state = createShell({});
    const result = await runWithPprFallbackShellState(state, async () => ({
      navigation: await settle(navigation()),
      prefetch: await settle(prefetch()),
    }));
    state.abortController.abort();
    expect(result).toEqual({ navigation: "resolved", prefetch: "resolved" });
    expect(state.hasDynamicBoundary).toBe(false);
  });

  it("leave holes in an App Shell", async () => {
    const state = createShell({ prefetchStage: "shell" });
    const result = await runWithPprFallbackShellState(state, async () => ({
      navigation: await settle(navigation()),
      prefetch: await settle(prefetch()),
    }));
    state.abortController.abort();
    expect(result).toEqual({ navigation: "pending", prefetch: "pending" });
    expect(state.hasDynamicBoundary).toBe(true);
  });

  it("render what follows prefetch() in a runtime prefetch, and leave navigation() out", async () => {
    const state = createShell({ isRuntimePrefetch: true });
    const result = await runWithPprFallbackShellState(state, async () => ({
      navigation: await settle(navigation()),
      prefetch: await settle(prefetch()),
    }));
    state.abortController.abort();
    expect(result).toEqual({ navigation: "pending", prefetch: "resolved" });
  });

  it("render both in a runtime prefetch to the navigation stage", async () => {
    const state = createShell({ isRuntimePrefetch: true, prefetchStage: "navigation" });
    const result = await runWithPprFallbackShellState(state, async () => ({
      navigation: await settle(navigation()),
      prefetch: await settle(prefetch()),
    }));
    state.abortController.abort();
    expect(result).toEqual({ navigation: "resolved", prefetch: "resolved" });
  });

  it("need Cache Components", () => {
    process.env.__NEXT_CACHE_COMPONENTS = "false";
    expect(() => prefetch()).toThrow(
      "used `prefetch()`, which requires Cache Components to be enabled",
    );
    expect(() => navigation()).toThrow(
      "used `navigation()`, which requires Cache Components to be enabled",
    );
  });

  it('reject a call inside "use cache"', async () => {
    setCacheHandler(new MemoryCacheHandler());
    const cached = registerCachedFunction(async () => {
      await navigation();
      return "value";
    }, "cache-stages-use-cache");
    await expect(cached()).rejects.toThrow('used `navigation()` inside "use cache"');
  });

  it("reject a call inside unstable_cache()", async () => {
    const cached = unstable_cache(async () => {
      await prefetch();
      return "value";
    }, ["cache-stages-unstable-cache"]);
    await expect(cached()).rejects.toThrow(
      "used `prefetch()` inside a function cached with `unstable_cache()`",
    );
  });

  it("reject a call inside generateStaticParams", () => {
    expect(() =>
      workUnitAsyncStorage.run({ type: "generate-static-params" }, () => prefetch()),
    ).toThrow("used `prefetch()` inside `generateStaticParams`");
  });
});

// Ported from Next.js's MIN_SHELL_STALE (use-cache-wrapper.ts,
// vercel/next.js#98339): an App Shell leaves out a cache that goes stale
// within five minutes, which a static shell keeps.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/use-cache/constants.ts
describe("App Shell cache lifetimes", () => {
  async function renderCached(
    prefetchStage: PprFallbackShellPrefetchStage | undefined,
    id: string,
  ) {
    setCacheHandler(new MemoryCacheHandler());
    const cached = registerCachedFunction(async () => {
      cacheLife({ stale: 60, revalidate: 900, expire: 86_400 });
      return "value";
    }, id);
    const state = createShell(prefetchStage ? { prefetchStage } : {});
    const result = await runWithPprFallbackShellState(state, () => settle(cached()));
    state.abortController.abort();
    return result;
  }

  it("leaves out a cache that goes stale within five minutes", async () => {
    expect(await renderCached("shell", "app-shell-stale-60")).toBe("pending");
  });

  it("keeps it in a static shell", async () => {
    expect(await renderCached(undefined, "static-shell-stale-60")).toBe("resolved");
  });
});
