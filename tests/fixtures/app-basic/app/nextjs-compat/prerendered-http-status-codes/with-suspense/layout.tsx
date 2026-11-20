// Ported from Next.js: test/e2e/prerendered-http-status-codes
// https://github.com/vercel/next.js/tree/canary/test/e2e/prerendered-http-status-codes
import { Suspense } from "react";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <h1 id="layout">Shared layout</h1>
      <Suspense fallback={<p id="suspense-fallback">Loading...</p>}>{children}</Suspense>
    </>
  );
}
