import { Suspense } from "react";
import { cookies } from "next/headers";
import { isStaticToPartialRevalidated } from "./state";

// Ported from Next.js: test/e2e/app-dir/static-to-partial-rsc
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/static-to-partial-rsc/app/static-to-partial-rsc/%5Bkind%5D/page.tsx
// Fully static until /partial-prefetching/revalidate regenerates it, when it
// starts reading the request's cookies.
export default function StaticToPartialPage() {
  return (
    <main>
      <p id="ppf-static">Static shell</p>
      <Suspense fallback={<p id="caller-fallback">Loading request data</p>}>
        <Content />
      </Suspense>
    </main>
  );
}

async function Content() {
  if (!isStaticToPartialRevalidated()) {
    return <p id="build-content">Build-time content</p>;
  }
  const caller = (await cookies()).get("caller")?.value ?? "none";
  return <p id="caller">{`Caller: ${caller}`}</p>;
}
