/**
 * Cancellation registry for App Router prefetch setup, shared by `<Link>`
 * (link.tsx) and `router.prefetch()` (app-router-navigation.ts).
 *
 * Both start asynchronous setup (lazy module loads, the route manifest) before
 * they register a cache entry or issue a request. Each one registers a token
 * before its first `await` and re-checks `cancelled` after, so superseded
 * setup cannot register a cache entry or start a request.
 *
 * Cancellation is sticky and scoped to the destination:
 *   - a navigation to the same href will fetch that route itself, so a late
 *     prefetch would duplicate the request. Navigations elsewhere leave the
 *     prefetch alone — nothing else is going to fetch it, and dropping it
 *     would make the prefetch timing-dependent.
 *   - invalidating the whole cache (`invalidatePrefetchCache`, reached via
 *     `router.refresh()`) cancels every pending setup, which would otherwise
 *     repopulate one route from the pre-refresh generation.
 *
 * Sticky matters: a navigation to `/a` followed by one to `/b` must leave a
 * pending `/a` prefetch cancelled, which comparing against a "current
 * destination" value would not.
 *
 * This module has no React or route-trie dependencies so link.tsx can import
 * it statically while keeping app-router-navigation.ts off its synchronous path.
 */
import { isExternalUrl } from "../../utils/external-url.js";
import { toCanonicalBrowserNavigationHref, toSameOriginAppPath } from "../url-utils.js";

const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";
const __trailingSlash: boolean = process.env.__VINEXT_TRAILING_SLASH === "true";

export type PendingPrefetchSetup = { readonly destination: string; cancelled: boolean };
const pendingPrefetchSetups = new Set<PendingPrefetchSetup>();

export function beginPrefetchSetup(destination: string): PendingPrefetchSetup {
  const setup: PendingPrefetchSetup = { destination, cancelled: false };
  pendingPrefetchSetups.add(setup);
  return setup;
}

/** Drop a settled setup's token; cancelling it afterwards would be a no-op. */
export function endPrefetchSetup(setup: PendingPrefetchSetup): void {
  pendingPrefetchSetups.delete(setup);
}

/** Passing `null` cancels every pending setup regardless of destination. */
export function cancelPendingPrefetchSetups(destination: string | null): void {
  for (const setup of pendingPrefetchSetups) {
    if (destination === null || setup.destination === destination) {
      setup.cancelled = true;
    }
  }
}

/**
 * Normalize a navigation or prefetch target to the browser href both sides
 * compare on. Returns null when the target is not same-origin — no same-origin
 * prefetch can be a duplicate of it — and on the server, where
 * `navigateClientSide` can still be reached but there is nothing to cancel.
 */
export function toAppPrefetchDestination(href: string): string | null {
  if (typeof window === "undefined") return null;
  let localHref = href;
  if (isExternalUrl(href)) {
    const localPath = toSameOriginAppPath(href, __basePath);
    if (localPath == null) return null;
    localHref = localPath;
  }
  const browserHref = toCanonicalBrowserNavigationHref(
    localHref,
    window.location.href,
    __basePath,
    __trailingSlash,
  );
  try {
    // Same serialization as formatRscRequestPath in app-rsc-cache-busting.ts,
    // inlined so Link does not load that module synchronously. A pathname that
    // starts with "//" must not come back as a protocol-relative reference:
    // the prefetch path resolves this value against the current URL again and
    // would read its first segment as a host.
    const url = new URL(browserHref, window.location.href);
    const pathname = url.pathname.startsWith("//") ? `/.${url.pathname}` : url.pathname;
    return `${pathname}${url.search}`;
  } catch {
    return browserHref.split("#", 1)[0];
  }
}
