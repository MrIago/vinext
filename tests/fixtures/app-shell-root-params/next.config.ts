// Ported from Next.js: test/e2e/app-dir/segment-cache/app-shell-root-params
// https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/segment-cache/app-shell-root-params
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Opt the whole app into Partial Prefetching (non-eager). Under App Shells
  // this skips the per-link Speculative phase, so revealing a link prefetches
  // ONLY the shared shell. That makes each reveal observable as exactly "one
  // shell prefetch, or no requests at all" — which is what the assertions rely
  // on.
  partialPrefetching: true,
  experimental: {
    prefetchInlining: true,
    optimisticRouting: true,
    cachedNavigations: true,
    varyParams: true,
  },
};

export default nextConfig;
