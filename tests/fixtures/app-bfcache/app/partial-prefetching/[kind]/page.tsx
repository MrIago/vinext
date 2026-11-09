import { Suspense } from "react";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { navigation, prefetch } from "next/cache";

export function generateStaticParams() {
  return [{ kind: "shell" }, { kind: "partial" }, { kind: "navigation" }];
}

// Each stage of the page has its own boundary: the App Shell holds only the
// static heading, a prefetch adds what follows `prefetch()`, a navigation-stage
// prefetch what follows `navigation()`, and only the navigation itself renders
// the request's data, which arrives late.
export default function PartialPrefetchingPage() {
  return (
    <main>
      <p id="ppf-static">Static shell</p>
      <Suspense fallback={<p id="prefetch-fallback">Waiting for prefetch</p>}>
        <PrefetchContent />
      </Suspense>
      <Suspense fallback={<p id="navigation-fallback">Waiting for navigation</p>}>
        <NavigationContent />
      </Suspense>
      <Suspense fallback={<p id="caller-fallback">Loading request data</p>}>
        <Caller />
      </Suspense>
    </main>
  );
}

async function PrefetchContent() {
  await prefetch();
  return <p id="prefetch-content">Prefetch content</p>;
}

async function NavigationContent() {
  await navigation();
  return <p id="navigation-content">Navigation content</p>;
}

async function Caller() {
  await connection();
  const caller = (await cookies()).get("caller")?.value ?? "none";
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return <p id="caller">{`Caller: ${caller}`}</p>;
}
