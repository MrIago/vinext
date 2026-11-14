// The runtime ISR side of Next.js's test/e2e/prerendered-http-status-codes:
// nothing here is prerendered, so the first request writes the entry.
// https://github.com/vercel/next.js/tree/canary/test/e2e/prerendered-http-status-codes
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";

export const revalidate = 60;

export function generateStaticParams() {
  return [];
}

async function HTTPError({ kind }: { kind: string }) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (kind === "not-found") notFound();
  if (kind === "redirect") redirect("/");
  return <p id="page">No error</p>;
}

export default async function Page({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  return (
    <main>
      <h1 id="layout">ISR status</h1>
      <Suspense fallback={<p id="suspense-fallback">Loading...</p>}>
        <HTTPError kind={kind} />
      </Suspense>
    </main>
  );
}
