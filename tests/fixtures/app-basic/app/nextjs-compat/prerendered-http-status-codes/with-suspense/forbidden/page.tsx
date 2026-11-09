// Ported from Next.js: test/e2e/prerendered-http-status-codes
// https://github.com/vercel/next.js/tree/canary/test/e2e/prerendered-http-status-codes
import { forbidden } from "next/navigation";

export default async function Page() {
  return forbidden();
}
