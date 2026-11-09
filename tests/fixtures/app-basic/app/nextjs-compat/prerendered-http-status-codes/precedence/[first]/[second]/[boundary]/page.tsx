// Ported from Next.js: test/e2e/prerendered-http-status-codes
// https://github.com/vercel/next.js/tree/canary/test/e2e/prerendered-http-status-codes
import { HTTPErrorPair } from "../../../http-error";

// A subset of Next.js's pairs: each precedence rule once per boundary.
const PAIRS = [
  ["not-found", "forbidden"],
  ["forbidden", "not-found"],
  ["unauthorized", "redirect"],
  ["redirect", "not-found"],
  ["redirect", "permanent-redirect"],
];

export function generateStaticParams() {
  return PAIRS.flatMap(([first, second]) =>
    ["suspense", "root"].map((boundary) => ({ first, second, boundary })),
  );
}

export default async function Page({
  params,
}: {
  params: Promise<{ first: string; second: string; boundary: string }>;
}) {
  const { first, second, boundary } = await params;
  return <HTTPErrorPair first={first} second={second} boundary={boundary} />;
}
