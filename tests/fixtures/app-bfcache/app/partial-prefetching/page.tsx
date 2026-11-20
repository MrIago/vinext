import Link from "next/link";
import { LinkAccordion } from "./link-accordion";

export default function PartialPrefetchingIndex() {
  return (
    <main>
      <h1 id="ppf-index">Partial Prefetching</h1>
      <LinkAccordion href="/partial-prefetching/shell">Shell</LinkAccordion>
      <LinkAccordion href="/partial-prefetching/partial" prefetch={true}>
        Partial
      </LinkAccordion>
      <LinkAccordion href="/partial-prefetching/navigation" prefetch="navigation">
        Navigation
      </LinkAccordion>
      <LinkAccordion href="/partial-prefetching/static-to-partial">Static to partial</LinkAccordion>
      <Link id="legacy-full-link" href="/partial-prefetching-legacy" prefetch={true}>
        Legacy full prefetch
      </Link>
    </main>
  );
}
