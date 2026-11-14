// The routes below opt into Partial Prefetching on their own, as Next.js's
// segment config allows: a <Link>'s automatic prefetch gets the App Shell, and
// prefetch={true} a partial prefetch to the prefetch stage.
export const prefetch = "partial";

export default function PartialPrefetchingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
