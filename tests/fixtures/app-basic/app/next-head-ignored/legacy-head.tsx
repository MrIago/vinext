"use client";

import Head from "next/head";

// A client component that renders next/head, as a layout shared between the
// Pages Router and the App Router would. Next.js ignores it in the App Router.
export function LegacyHead() {
  return (
    <Head>
      <title>From next/head</title>
      <meta name="description" content="from next/head" />
    </Head>
  );
}
