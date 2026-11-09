// Ported from Next.js: test/e2e/app-dir/ensure-static-navigation
// https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/ensure-static-navigation
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Set in tests
  // partialPrefetching: true,
};

export default nextConfig;
