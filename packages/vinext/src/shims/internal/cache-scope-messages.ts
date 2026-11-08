/**
 * The user-facing errors for request APIs and cache composition inside
 * `"use cache"`, `"use cache: private"` and `unstable_cache()`.
 *
 * Ported from Next.js: packages/next/src/server/use-cache/use-cache-messages.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/use-cache/use-cache-messages.ts
 *
 * Each message states the scope and constraint, gives the immediate fix and
 * ends with Next.js's `Learn more:` link. Next.js prefixes every message with
 * `Route "<route>": `; vinext doesn't track the route at these throw sites, so
 * the prefix is added only when a caller passes one, as Next.js itself does
 * for `cacheTag()` / `cacheLife()` when no work store exists.
 */

const NEXT_REQUEST_IN_USE_CACHE = "https://nextjs.org/docs/messages/next-request-in-use-cache";
const UNSTABLE_CACHE_API_DOCS =
  "https://nextjs.org/docs/app/api-reference/functions/unstable_cache";
const USE_CACHE_PRIVATE_COMPOSITION =
  "https://nextjs.org/docs/messages/use-cache-private-composition";
const NESTED_USE_CACHE_NO_EXPLICIT_CACHELIFE =
  "https://nextjs.org/docs/messages/nested-use-cache-no-explicit-cachelife";

export type CacheScope = "use cache" | "unstable_cache";

function routePrefix(route: string | undefined): string {
  return route === undefined ? "" : `Route "${route}": `;
}

function scopeLabel(scope: CacheScope): string {
  return scope === "unstable_cache" ? "`unstable_cache()`" : '`"use cache"`';
}

function learnMore(scope: CacheScope): string {
  return scope === "unstable_cache" ? UNSTABLE_CACHE_API_DOCS : NEXT_REQUEST_IN_USE_CACHE;
}

/**
 * The error a request API throws inside a cache scope. `apiName` is the
 * expression as vinext reports it (`headers()`, `searchParams`,
 * `request.url`, `draftMode().enable()`, `connection()`), and picks the
 * template Next.js uses for that kind of access.
 */
export function createRequestApiInCacheScopeError(
  apiName: string,
  scope: CacheScope,
  route?: string,
): Error {
  const prefix = routePrefix(route);
  if (apiName === "connection()") {
    return new Error(
      `${prefix}\`connection()\` can't be called inside ${scopeLabel(scope)} because cached functions may run during prerendering, without an incoming request. Call it outside the cached function.\nLearn more: ${learnMore(scope)}`,
    );
  }
  if (apiName.startsWith("draftMode().")) {
    return new Error(
      `${prefix}\`${apiName}\` can't be called inside ${scopeLabel(scope)}. Draft mode can be read inside a cached function, but enabling or disabling it must happen outside.\nLearn more: ${learnMore(scope)}`,
    );
  }
  const fix =
    apiName === "searchParams"
      ? "Await it outside the cached function and pass what you need as an argument."
      : "Read it outside the cached function and pass what you need as an argument.";
  return new Error(
    `${prefix}\`${apiName}\` can't be read inside ${scopeLabel(scope)}. ${fix}\nLearn more: ${learnMore(scope)}`,
  );
}

export function createUseCachePrivateInsidePublicUseCacheError(route?: string): Error {
  return new Error(
    `${routePrefix(route)}\`"use cache: private"\` can't be nested inside \`"use cache"\` because a shared cached function can't depend on private request data. Nest it only inside another \`"use cache: private"\`.\nLearn more: ${USE_CACHE_PRIVATE_COMPOSITION}`,
  );
}

export function createUseCachePrivateInsideUnstableCacheError(route?: string): Error {
  return new Error(
    `${routePrefix(route)}\`"use cache: private"\` can't be used inside \`unstable_cache()\` because \`unstable_cache()\` uses a shared cache that can't contain private request data. Call the private cached function outside \`unstable_cache()\`.\nLearn more: ${USE_CACHE_PRIVATE_COMPOSITION}`,
  );
}

export function createNestedCacheZeroRevalidateError(cause: unknown, route?: string): Error {
  return new Error(
    `${routePrefix(route)}A nested \`"use cache"\` with \`revalidate: 0\` is inside an outer \`"use cache"\` that has no \`cacheLife()\`. Add \`cacheLife()\` to the outer one to choose whether to prerender it with a non-zero \`revalidate\` or keep it dynamic with \`revalidate: 0\`.\nLearn more: ${NESTED_USE_CACHE_NO_EXPLICIT_CACHELIFE}`,
    { cause },
  );
}

export function createNestedCacheShortExpireError(cause: unknown, route?: string): Error {
  return new Error(
    `${routePrefix(route)}A nested \`"use cache"\` with a short \`expire\` (under 5 minutes) is inside an outer \`"use cache"\` that has no \`cacheLife()\`. Add \`cacheLife()\` to the outer one to choose whether to prerender it with a longer \`expire\` or keep it dynamic with a short \`expire\`.\nLearn more: ${NESTED_USE_CACHE_NO_EXPLICIT_CACHELIFE}`,
    { cause },
  );
}
