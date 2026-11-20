// Ported from Next.js: test/e2e/prerendered-http-status-codes
// https://github.com/vercel/next.js/tree/canary/test/e2e/prerendered-http-status-codes
import { notFound } from "next/navigation";
import { connection } from "next/server";

export default async function Page() {
  await connection();
  return notFound();
}
