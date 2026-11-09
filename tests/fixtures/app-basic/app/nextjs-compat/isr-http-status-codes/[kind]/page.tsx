// The runtime ISR side of Next.js's test/e2e/prerendered-http-status-codes:
// nothing here is prerendered, so the first request writes the entry.
// https://github.com/vercel/next.js/tree/canary/test/e2e/prerendered-http-status-codes
import { Suspense } from "react";
import { forbidden, notFound, permanentRedirect, redirect, unauthorized } from "next/navigation";
import { HTTPErrorPair } from "../../prerendered-http-status-codes/precedence/http-error";

export const revalidate = 60;

export function generateStaticParams() {
  return [];
}

async function HTTPError({ kind }: { kind: string }) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  switch (kind) {
    case "not-found":
      return notFound();
    case "forbidden":
      return forbidden();
    case "unauthorized":
      return unauthorized();
    case "redirect":
      return redirect("/");
    case "permanent-redirect":
      return permanentRedirect("/");
    default:
      return <p id="page">No error</p>;
  }
}

export default async function Page({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  return (
    <>
      <h1 id="layout">ISR status</h1>
      {kind === "precedence" ? (
        <HTTPErrorPair first="not-found" second="redirect" boundary="suspense" />
      ) : (
        <Suspense fallback={<p id="suspense-fallback">Loading...</p>}>
          <HTTPError kind={kind} />
        </Suspense>
      )}
    </>
  );
}
