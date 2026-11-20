"use client";
// Ported from Next.js: test/e2e/prerendered-http-status-codes
// https://github.com/vercel/next.js/tree/canary/test/e2e/prerendered-http-status-codes
import { Suspense, use } from "react";
import { forbidden, notFound, permanentRedirect, redirect, unauthorized } from "next/navigation";

function throwHTTPError(type: string, destination: string): never {
  switch (type) {
    case "not-found":
      return notFound();
    case "unauthorized":
      return unauthorized();
    case "forbidden":
      return forbidden();
    case "redirect":
      return redirect(destination);
    case "permanent-redirect":
      return permanentRedirect(destination);
    default:
      throw new Error(`Unknown HTTP error type: ${type}`);
  }
}

function FirstError({ type, onError }: { type: string; onError: () => void }) {
  try {
    return throwHTTPError(type, "/first");
  } finally {
    onError();
  }
}

function SecondError({ type, after }: { type: string; after: Promise<void> }) {
  use(after);
  return throwHTTPError(type, "/second");
}

export function HTTPErrorPair({
  first,
  second,
  boundary,
}: {
  first: string;
  second: string;
  boundary: string;
}) {
  let resolveFirstError!: () => void;
  const firstError = new Promise<void>((resolve) => {
    resolveFirstError = resolve;
  });
  // Wait for the first error before rendering the second, even when it is in
  // the shell. The promise belongs to this render.
  const secondError = <SecondError type={second} after={firstError} />;

  return (
    <>
      <h1 id="precedence-layout">HTTP error precedence</h1>
      <Suspense fallback={<p id="first-fallback">First fallback</p>}>
        <FirstError type={first} onError={() => resolveFirstError()} />
      </Suspense>
      {boundary === "suspense" ? (
        <Suspense fallback={<p id="second-fallback">Second fallback</p>}>{secondError}</Suspense>
      ) : (
        // The second error rejects the shell instead.
        secondError
      )}
    </>
  );
}
