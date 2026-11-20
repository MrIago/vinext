// Ported from Next.js: test/e2e/app-dir/ensure-static-navigation-runtime
// https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/ensure-static-navigation-runtime
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Set in tests
  // partialPrefetching: true,
};

export default nextConfig;
