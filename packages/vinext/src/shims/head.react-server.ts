/**
 * next/head shim for the RSC environment.
 *
 * Next.js aliases `next/head` to a noop component for App Router code
 * (`client/components/noop-head.tsx`): App Router titles come from the
 * Metadata API. The resolver warns once when a Server Component imports it.
 */
export default function NoopHead(): null {
  return null;
}
