/**
 * Typed links for `typedRoutes: true` (#3075).
 *
 * Next.js writes `.next/types/link.d.ts` next to its route types when
 * `typedRoutes` is on: a `Route<T>` that only accepts the app's routes, and
 * typed `href`/`action`/`push`/`replace`/`prefetch`/`redirect` for `next/link`,
 * `next/navigation` and `next/form`.
 *
 * Ported from Next.js:
 * - packages/next/src/server/lib/router-utils/typegen.ts
 *   (`formatRouteToRouteType`, `serializeRouteTypes`, `generateLinkTypesFile`)
 * - packages/next/src/server/lib/router-utils/route-types-utils.ts
 *   (`convertCustomRouteSource`)
 * - packages/next/src/shared/lib/router/utils/is-dynamic.ts (strict `isDynamicRoute`)
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-utils/typegen.ts
 */
import { parsePathPattern } from "../utils/path-to-regexp.js";

/** Route (Next.js format, such as `/blog/[slug]`) → the file or source behind it. */
export type LinkRouteMap = Record<string, { path: string }>;

export type LinkTypesManifest = {
  appRoutes: LinkRouteMap;
  pageRoutes: LinkRouteMap;
  redirectRoutes: LinkRouteMap;
  rewriteRoutes: LinkRouteMap;
  appRouteHandlerRoutes: LinkRouteMap;
  /** Pages Router API routes, keyed by file path as Next.js does. */
  pageApiRoutes: Iterable<string>;
};

const TEST_STRICT_ROUTE = /\/\[[^/]+\](?=\/|$)/;

function formatRouteToRouteType(route: string): { isDynamic: boolean; routeType: string } {
  const isDynamic = TEST_STRICT_ROUTE.test(route);
  if (isDynamic) {
    route = route
      .split("/")
      .map((part) => {
        if (part.startsWith("[") && part.endsWith("]")) {
          if (part.startsWith("[...")) return "${CatchAllSlug<T>}";
          if (part.startsWith("[[...") && part.endsWith("]]")) return "${OptionalCatchAllSlug<T>}";
          return "${SafeSlug<T>}";
        }
        return part;
      })
      .join("/");
  }
  return { isDynamic, routeType: route };
}

function serializeRouteTypes(routeTypes: [routeType: string, cause: string][]): string {
  // Route collection order is not deterministic; sort so the file is.
  routeTypes.sort(([a], [b]) => a.localeCompare(b));
  let union = "";
  for (const [route, cause] of routeTypes) {
    union += `\n    | \`${route}\` // ${cause}`;
  }
  return union;
}

/**
 * The routes a `redirects()`/`rewrites()` source can match, in Next.js route
 * form. Named and unnamed params become `[slug]`/`[...slug]`/`[[...slug]]`;
 * an optional plain-text segment forks the route; any other regex makes the
 * source untypeable, so it contributes no route.
 */
export function convertCustomRouteSource(source: string): string[] {
  let tokens;
  try {
    tokens = parsePathPattern(source);
  } catch {
    return source.startsWith("/") ? [source] : [`/${source}`];
  }

  const possibleNormalizedRoutes = [""];
  let slugCnt = 1;
  const append = (suffix: string) => {
    for (let i = 0; i < possibleNormalizedRoutes.length; i++) possibleNormalizedRoutes[i] += suffix;
  };
  const fork = (suffix: string) => {
    const currentLength = possibleNormalizedRoutes.length;
    for (let i = 0; i < currentLength; i++) {
      possibleNormalizedRoutes.push(possibleNormalizedRoutes[i] + suffix);
    }
  };

  for (const token of tokens) {
    if (typeof token === "object") {
      // Make sure the slug is always named.
      const slug =
        typeof token.name === "string" && token.name
          ? token.name
          : slugCnt++ === 1
            ? "slug"
            : `slug${slugCnt}`;
      if (token.modifier === "*") {
        append(`${token.prefix}[[...${slug}]]`);
      } else if (token.modifier === "+") {
        append(`${token.prefix}[...${slug}]`);
      } else if (token.modifier === "") {
        if (token.pattern === "[^\\/#\\?]+?") {
          append(`${token.prefix}[${slug}]`);
        } else if (token.pattern === ".*") {
          append(`${token.prefix}[[...${slug}]]`);
        } else if (token.pattern === ".+") {
          append(`${token.prefix}[...${slug}]`);
        } else {
          // Other regex patterns are not supported. Skip this route.
          return [];
        }
      } else if (token.modifier === "?") {
        if (/^[a-zA-Z0-9_/]*$/.test(token.pattern)) {
          // An optional slug with plain text only, fork the route.
          append(token.prefix);
          fork(token.pattern);
        } else {
          // Optional modifier `?` and regex patterns are not supported.
          return [];
        }
      }
    } else {
      append(token);
    }
  }

  return possibleNormalizedRoutes.map((route) => (route.startsWith("/") ? route : `/${route}`));
}

export function generateLinkTypesFile(routesManifest: LinkTypesManifest): string {
  const visited = new Set<string>();
  const staticRouteTypes: [routeType: string, cause: string][] = [];
  const dynamicRouteTypes: [routeType: string, cause: string][] = [];

  for (const routeMap of [
    routesManifest.appRoutes,
    routesManifest.pageRoutes,
    routesManifest.redirectRoutes,
    routesManifest.rewriteRoutes,
    routesManifest.appRouteHandlerRoutes,
  ]) {
    for (const route in routeMap) {
      if (visited.has(route)) continue;
      visited.add(route);
      const { isDynamic, routeType } = formatRouteToRouteType(route);
      const cause = routeMap[route]!.path;
      (isDynamic ? dynamicRouteTypes : staticRouteTypes).push([routeType, cause]);
    }
  }

  // Pages Router API routes are stored as file paths.
  for (const filePath of routesManifest.pageApiRoutes) {
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    const { isDynamic, routeType } = formatRouteToRouteType(filePath);
    (isDynamic ? dynamicRouteTypes : staticRouteTypes).push([routeType, filePath]);
  }

  const serializedStaticRouteTypes = serializeRouteTypes(staticRouteTypes);
  const serializedDynamicRouteTypes = serializeRouteTypes(dynamicRouteTypes);

  // If both StaticRoutes and DynamicRoutes are empty, fall back to `string & {}`.
  const routeTypesFallback =
    !serializedStaticRouteTypes && !serializedDynamicRouteTypes ? "string & {}" : "";

  return `// This file is generated automatically by Next.js
// Do not edit this file manually

// Type definitions for Next.js routes

/**
 * Internal types used by the Next.js router and Link component.
 * These types are not meant to be used directly.
 * @internal
 */
declare namespace __next_route_internal_types__ {
  type SearchOrHash = \`?\${string}\` | \`#\${string}\`
  type WithProtocol = \`\${string}:\${string}\`

  type Suffix = '' | SearchOrHash

  type SafeSlug<S extends string> = S extends \`\${string}/\${string}\`
    ? never
    : S extends \`\${string}\${SearchOrHash}\`
    ? never
    : S extends ''
    ? never
    : S

  type CatchAllSlug<S extends string> = S extends \`\${string}\${SearchOrHash}\`
    ? never
    : S extends ''
    ? never
    : S

  type OptionalCatchAllSlug<S extends string> =
    S extends \`\${string}\${SearchOrHash}\` ? never : S

  type StaticRoutes = ${serializedStaticRouteTypes || "never"}
  type DynamicRoutes<T extends string = string> = ${serializedDynamicRouteTypes || "never"}

  type RouteImpl<T> = ${
    routeTypesFallback ||
    `
    | StaticRoutes
    | SearchOrHash
    | WithProtocol
    | \`\${StaticRoutes}\${SearchOrHash}\`
    | (T extends \`\${DynamicRoutes<infer _>}\${Suffix}\` ? T : never)
    `
  }
}

declare module 'next' {
  export { default } from 'next/types.js'
  export * from 'next/types.js'

  export type Route<T extends string = string> =
    __next_route_internal_types__.RouteImpl<T>
}

declare module 'next/link' {
  export { useLinkStatus } from 'next/dist/client/link.js'

  import type { LinkProps as OriginalLinkProps } from 'next/dist/client/link.js'
  import type { AnchorHTMLAttributes, DetailedHTMLProps } from 'react'
  import type { UrlObject } from 'url'

  type LinkRestProps = Omit<
    Omit<
      DetailedHTMLProps<
        AnchorHTMLAttributes<HTMLAnchorElement>,
        HTMLAnchorElement
      >,
      keyof OriginalLinkProps
    > &
      OriginalLinkProps,
    'href'
  >

  export type LinkProps<RouteInferType> = LinkRestProps & {
    /**
     * The path or URL to navigate to. This is the only required prop. It can also be an object.
     * @see https://nextjs.org/docs/api-reference/next/link
     */
    href: __next_route_internal_types__.RouteImpl<RouteInferType> | UrlObject
  }

  export default function Link<RouteType>(props: LinkProps<RouteType>): JSX.Element
}

declare module 'next/navigation' {
  export * from 'next/dist/client/components/navigation.js'

  import type { NavigateOptions, PrefetchOptions, AppRouterInstance as OriginalAppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js'
  import type { RedirectType } from 'next/dist/client/components/redirect-error.js'

  interface AppRouterInstance extends OriginalAppRouterInstance {
    /**
     * Navigate to the provided href.
     * Pushes a new history entry.
     */
    push<RouteType>(href: __next_route_internal_types__.RouteImpl<RouteType>, options?: NavigateOptions): void
    /**
     * Navigate to the provided href.
     * Replaces the current history entry.
     */
    replace<RouteType>(href: __next_route_internal_types__.RouteImpl<RouteType>, options?: NavigateOptions): void
    /**
     * Prefetch the provided href.
     */
    prefetch<RouteType>(href: __next_route_internal_types__.RouteImpl<RouteType>, options?: PrefetchOptions): void
  }

  export function useRouter(): AppRouterInstance;

  /**
   * This function allows you to redirect the user to another URL. It can be used in
   * [Server Components](https://nextjs.org/docs/app/building-your-application/rendering/server-components),
   * [Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers), and
   * [Server Actions](https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations).
   *
   * - In a Server Component, this will insert a meta tag to redirect the user to the target page.
   * - In a Route Handler, it will serve a 307 to the caller.
   * - In a Server Action, it will perform a client-side navigation when JavaScript is available or serve a 303 for a progressive enhancement form submission.
   * - In a Server Action, type defaults to 'push' and 'replace' elsewhere.
   *
   * Read more: [Next.js Docs: redirect](https://nextjs.org/docs/app/api-reference/functions/redirect)
   */
  export function redirect<RouteType>(
    /** The URL to redirect to */
    url: __next_route_internal_types__.RouteImpl<RouteType>,
    type?: RedirectType
  ): never;

  /**
   * This function allows you to redirect the user to another URL. It can be used in
   * [Server Components](https://nextjs.org/docs/app/building-your-application/rendering/server-components),
   * [Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers), and
   * [Server Actions](https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations).
   *
   * - In a Server Component, this will insert a meta tag to redirect the user to the target page.
   * - In a Route Handler, it will serve a 308 to the caller.
   * - In a Server Action, it will perform a client-side navigation when JavaScript is available or serve a 303 for a progressive enhancement form submission.
   *
   * Read more: [Next.js Docs: redirect](https://nextjs.org/docs/app/api-reference/functions/redirect)
   */
  export function permanentRedirect<RouteType>(
    /** The URL to redirect to */
    url: __next_route_internal_types__.RouteImpl<RouteType>,
    type?: RedirectType
  ): never;
}

declare module 'next/form' {
  import type { FormProps as OriginalFormProps } from 'next/dist/client/form.js'

  type FormRestProps = Omit<OriginalFormProps, 'action'>

  export type FormProps<RouteInferType> = {
    /**
     * \`action\` can be either a \`string\` or a function.
     * - If \`action\` is a string, it will be interpreted as a path or URL to navigate to when the form is submitted.
     *   The path will be prefetched when the form becomes visible.
     * - If \`action\` is a function, it will be called when the form is submitted. See the [React docs](https://react.dev/reference/react-dom/components/form#props) for more.
     */
    action: __next_route_internal_types__.RouteImpl<RouteInferType> | ((formData: FormData) => void)
  } & FormRestProps

  export default function Form<RouteType>(props: FormProps<RouteType>): JSX.Element
}
`;
}
